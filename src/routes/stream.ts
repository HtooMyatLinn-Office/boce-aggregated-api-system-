import { Router } from 'express';
import { config } from '../config';
import {
  getCachedStreamBest,
  getLastStreamResult,
} from '../services/queue/streamProbe/job';
import { enqueueStreamProbeJob, streamProbeQueue } from '../services/queue/streamProbe/queue';
import { toRegionCode } from '../services/stream-ranking/codeMapper';

export const streamRouter = Router();

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
    const job = await enqueueStreamProbeJob({ region });
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
