import { Queue, Job } from 'bullmq';
import { config } from '../../../config';
import { parseRedisUrl } from '../util';
import { STREAM_PROBE_QUEUE_NAME, StreamProbeJobData, StreamBestPayload } from './job';

const bullConnection = parseRedisUrl(config.redis?.url ?? 'redis://localhost:6379');

export const streamProbeQueue = new Queue<StreamProbeJobData, StreamBestPayload, string>(
  STREAM_PROBE_QUEUE_NAME,
  {
    connection: bullConnection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 3000 },
      removeOnComplete: { age: 60 * 60, count: 500 },
      removeOnFail: { age: 24 * 60 * 60, count: 500 },
    },
  }
);

function randomInterJobDelayMs(): number {
  return 2000 + Math.floor(Math.random() * 3000);
}

export async function enqueueStreamProbeJob(
  data: StreamProbeJobData,
  opts?: { delayMs?: number }
): Promise<Job<StreamProbeJobData, StreamBestPayload, string>> {
  const delayMs = opts?.delayMs ?? randomInterJobDelayMs();
  return streamProbeQueue.add('streamProbe', data, { delay: delayMs });
}

function normalizeRegion(region: string): string {
  return region.trim().toLowerCase();
}

/** Reuse existing in-flight job for the same region to avoid duplicate queue work. */
export async function getOrEnqueueStreamProbeJob(
  data: StreamProbeJobData,
  opts?: { delayMs?: number }
): Promise<Job<StreamProbeJobData, StreamBestPayload, string>> {
  const target = normalizeRegion(data.region);
  const inFlight = await streamProbeQueue.getJobs(['waiting', 'active', 'delayed', 'prioritized'], 0, 200);
  const existing = inFlight.find((job) => normalizeRegion(job.data.region) === target);
  if (existing) return existing;
  return enqueueStreamProbeJob(data, opts);
}
