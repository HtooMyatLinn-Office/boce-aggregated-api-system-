/**
 * Stream probe pipeline: sampling → m3u8 → first .ts → existing detectOnce → rank → Redis.
 * Reuses `detectOnce` (Boce batch/curl probe) without duplicating probe logic.
 */

import { config } from '../../../config';
import { getRedis } from '../redis';
import { detectOnce } from '../../detection/detect';
import { fetchAndExtractFirstTs, M3u8ParseError } from '../../m3u8/parser';
import { pivotRankingByIsp, SourceProbeGroup, IspPivotNode } from '../../stream-ranking/service';
import { sampleM3u8UrlsForRegion } from '../../stream-sampling/service';
import { selectStreamProbeNodeIds } from '../../stream-sampling/nodeIds';
import { toRegionCode } from '../../stream-ranking/codeMapper';

export const STREAM_PROBE_QUEUE_NAME = 'stream-probe';

export interface StreamProbeJobData {
  region: string;
}

export interface StreamBestPayload {
  region: string;
  nodes: IspPivotNode[];
  sampledSources: number;
  probedSources: number;
  probedAt: string;
}

const BEST_KEY = (region: string) => `stream:best:${encodeURIComponent(region.trim().toLowerCase())}`;
const LAST_KEY = (region: string) => `stream:last:${encodeURIComponent(region.trim().toLowerCase())}`;

function cacheTtlSec(): number {
  const min = Math.max(60, config.stream.cacheTtlMinSec);
  const max = Math.max(min, config.stream.cacheTtlMaxSec);
  return Math.floor(min + Math.random() * (max - min + 1));
}

export async function getCachedStreamBest(region: string): Promise<StreamBestPayload | null> {
  const raw = await getRedis().get(BEST_KEY(region));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StreamBestPayload;
  } catch {
    return null;
  }
}

export async function getLastStreamResult(region: string): Promise<StreamBestPayload | null> {
  const raw = await getRedis().get(LAST_KEY(region));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StreamBestPayload;
  } catch {
    return null;
  }
}

function randomProbeDelayMs(): number {
  const min = Math.max(0, config.stream.probeDelayMinMs);
  const max = Math.max(min, config.stream.probeDelayMaxMs);
  return min + Math.floor(Math.random() * (max - min + 1));
}

function randomBatchDelayMs(): number {
  const min = Math.max(0, config.stream.sourceBatchDelayMinMs);
  const max = Math.max(min, config.stream.sourceBatchDelayMaxMs);
  return min + Math.floor(Math.random() * (max - min + 1));
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function runInBatches<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  const size = Math.max(1, concurrency);
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    await Promise.all(batch.map((item) => worker(item)));
    if (i + size < items.length) {
      await sleep(randomBatchDelayMs());
    }
  }
}

/**
 * Full job run: cache short-circuit → playback sample → m3u8 → ts → detectOnce → rankBySource → Redis.
 * Throws on Boce failures so BullMQ can retry; catches sampling/m3u8 errors into an empty ranking.
 */
export async function runStreamProbePipeline(region: string): Promise<StreamBestPayload> {
  const trimmed = region.trim();
  const cached = await getCachedStreamBest(trimmed);
  if (cached) return cached;

  const { sources } = await sampleM3u8UrlsForRegion(trimmed);
  const timeoutMs = config.stream.m3u8FetchTimeoutMs;
  const sampledSources = sources.length;

  const nodeIds = await selectStreamProbeNodeIds(trimmed, config.stream.maxNodes);
  const probedAt = new Date().toISOString();
  if (!nodeIds || sources.length === 0) {
    const empty: StreamBestPayload = {
      region: toRegionCode(trimmed),
      nodes: [],
      sampledSources,
      probedSources: 0,
      probedAt,
    };
    await persistStreamResultForRequestRegion(trimmed, empty);
    return empty;
  }

  const sourceProbeGroups: SourceProbeGroup[] = [];
  let probedSources = 0;
  let skippedSources = 0;
  let failedSources = 0;
  const sourceConcurrency = Math.max(1, config.stream.sourceConcurrency);

  const handleSource = async (source: { m3u8Url: string; sourceCode: string }) => {
    try {
      const { tsUrl } = await fetchAndExtractFirstTs(source.m3u8Url, timeoutMs);
      if (!tsUrl || tsUrl.toLowerCase().includes('.m3u8')) {
        skippedSources += 1;
        return;
      }

      // Reuse existing pipeline per source; keep pacing to avoid overload.
      const detection = await detectOnce({ url: tsUrl, nodeIds });
      sourceProbeGroups.push({
        sourceCode: source.sourceCode,
        probes: detection.probes,
      });
      probedSources += 1;
      await sleep(randomProbeDelayMs());
    } catch (e) {
      if (e instanceof M3u8ParseError) {
        skippedSources += 1;
        return;
      }
      // Skip source-level failures; keep the worker resilient.
      failedSources += 1;
      return;
    }
  };

  await runInBatches(sources, sourceConcurrency, handleSource);

  console.info('streamProbe source processing summary', {
    region: trimmed,
    totalSourcesFetched: sampledSources,
    totalSourcesProbed: probedSources,
    skippedSources,
    failedSources,
    sourceConcurrency,
  });

  const ranked = pivotRankingByIsp(
    trimmed,
    sourceProbeGroups,
    sources.map((s) => s.sourceCode)
  );

  const payload: StreamBestPayload = {
    region: ranked.region,
    nodes: ranked.nodes,
    sampledSources,
    probedSources,
    probedAt,
  };
  await persistStreamResultForRequestRegion(trimmed, payload);
  return payload;
}

async function persistStreamResultForRequestRegion(
  requestRegion: string,
  payload: StreamBestPayload
): Promise<void> {
  const redis = getRedis();
  const body = JSON.stringify(payload);
  await redis.set(LAST_KEY(requestRegion), body);
  await redis.set(BEST_KEY(requestRegion), body, 'EX', cacheTtlSec());
}
