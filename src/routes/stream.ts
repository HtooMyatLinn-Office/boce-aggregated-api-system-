import { Router } from 'express';
import { config } from '../config';
import {
  getCachedStreamBest,
  getLastStreamResult,
} from '../services/queue/streamProbe/job';
import { getOrEnqueueStreamProbeJob, streamProbeQueue } from '../services/queue/streamProbe/queue';
import { toRegionCode } from '../services/stream-ranking/codeMapper';

export const streamRouter = Router();

const ALL_REGION_TARGETS: string[] = [
  'beijing', 'tianjin', 'shanghai', 'chongqing',
  'hebei', 'shanxi', 'liaoning', 'jilin', 'heilongjiang',
  'jiangsu', 'zhejiang', 'anhui', 'fujian', 'jiangxi',
  'shandong', 'henan', 'hubei', 'hunan', 'guangdong',
  'hainan', 'sichuan', 'guizhou', 'yunnan', 'shaanxi',
  'gansu', 'qinghai', 'neimenggu', 'guangxi', 'xizang',
  'ningxia', 'xinjiang', 'taiwan', 'hongkong', 'macau',
  'shenzhen', 'dongguan', 'foshan', 'hangzhou', 'nanjing',
  'suzhou', 'chengdu', 'wuhan', 'changsha', 'xian',
  'zhengzhou', 'qingdao', 'xiamen',
];

interface StreamRegionPayload {
  region: string;
  nodes: Array<{ code: string; nodeName?: string; ranking: Record<string, string> }>;
  sampledSources: number;
  probedSources: number;
  probedAt: string;
}

function makeEmptyRegionPayload(region: string): StreamRegionPayload {
  return {
    region: toRegionCode(region),
    nodes: [],
    sampledSources: 0,
    probedSources: 0,
    probedAt: new Date().toISOString(),
  };
}

/**
 * GET /api/stream/best?region=guangdong
 * Returns Redis cache when fresh; otherwise enqueues a probe job and returns the last known result when present.
 */
streamRouter.get('/best', async (req, res) => {
  const region = typeof req.query.region === 'string' ? req.query.region.trim() : '';
  if (!region) {
    res.status(400).json({ success: false, error: 'Missing query parameter region' });
    return;
  }

  if (region.toLowerCase() === 'all') {
    const payloads: StreamRegionPayload[] = [];
    const queued: Array<{ region: string; jobId: string | undefined }> = [];

    for (const target of ALL_REGION_TARGETS) {
      const fresh = await getCachedStreamBest(target);
      if (fresh) {
        payloads.push({
          region: fresh.region,
          nodes: fresh.nodes,
          sampledSources: fresh.sampledSources,
          probedSources: fresh.probedSources,
          probedAt: fresh.probedAt,
        });
        continue;
      }

      const last = await getLastStreamResult(target);
      payloads.push(
        last
          ? {
              region: last.region,
              nodes: last.nodes,
              sampledSources: last.sampledSources,
              probedSources: last.probedSources,
              probedAt: last.probedAt,
            }
          : makeEmptyRegionPayload(target)
      );

      if (config.queue.enabled) {
        const job = await getOrEnqueueStreamProbeJob({ region: target });
        queued.push({ region: target, jobId: job.id });
      }
    }

    const cachedOnly = queued.length === 0;
    res.json({
      success: true,
      cached: cachedOnly,
      stale: !cachedOnly,
      region: 'ALL',
      totalRegions: ALL_REGION_TARGETS.length,
      queuedRegions: queued.length,
      jobs: queued.map((q) => ({
        region: q.region,
        jobId: q.jobId,
        statusUrl: q.jobId ? `/api/stream/jobs/${q.jobId}` : undefined,
      })),
      results: payloads,
    });
    return;
  }

  const fresh = await getCachedStreamBest(region);
  if (fresh) {
    res.json({
      success: true,
      cached: true,
      region: fresh.region,
      nodes: fresh.nodes,
      sampledSources: fresh.sampledSources,
      probedSources: fresh.probedSources,
      probedAt: fresh.probedAt,
    });
    return;
  }

  const last = await getLastStreamResult(region);
  let jobId: string | undefined;

  if (config.queue.enabled) {
    const job = await getOrEnqueueStreamProbeJob({ region });
    jobId = job.id;
  }

  const base = last ?? {
    region: toRegionCode(region),
    nodes: [],
    sampledSources: 0,
    probedSources: 0,
    probedAt: new Date().toISOString(),
  };

  res.json({
    success: true,
    cached: false,
    stale: Boolean(last),
    jobId,
    statusUrl: jobId ? `/api/stream/jobs/${jobId}` : undefined,
    region: base.region,
    nodes: base.nodes,
    sampledSources: base.sampledSources,
    probedSources: base.probedSources,
    probedAt: base.probedAt,
  });
});

streamRouter.get('/jobs/:jobId', async (req, res) => {
  const { jobId } = req.params;
  const job = await streamProbeQueue.getJob(jobId);
  if (!job) {
    res.status(404).json({ success: false, error: 'Job not found' });
    return;
  }

  const state = await job.getState();
  const result = job.returnvalue ?? null;
  const failedReason = job.failedReason ?? null;

  res.json({
    success: true,
    jobId: job.id,
    state,
    attemptsMade: job.attemptsMade,
    failedReason,
    result,
  });
});
