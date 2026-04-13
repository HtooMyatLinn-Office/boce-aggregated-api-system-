import { Worker, Job } from 'bullmq';
import { config } from '../../../config';
import { parseRedisUrl } from '../util';
import { runStreamProbePipeline, StreamProbeJobData, StreamBestPayload, STREAM_PROBE_QUEUE_NAME } from './job';

const bullConnection = parseRedisUrl(config.redis?.url ?? 'redis://localhost:6379');

let worker: Worker<StreamProbeJobData, StreamBestPayload, string> | undefined;

/**
 * Concurrency 2; spacing between jobs is enforced via enqueue delay (2–5s) + worker limiter.
 */
export function startStreamProbeWorker(): void {
  if (!config.queue.enabled) return;
  if (worker) return;

  worker = new Worker<StreamProbeJobData, StreamBestPayload, string>(
    STREAM_PROBE_QUEUE_NAME,
    async (job: Job<StreamProbeJobData, StreamBestPayload>) => {
      const region = typeof job.data.region === 'string' ? job.data.region.trim() : '';
      if (!region) {
        return {
          region: 'OTHER',
          nodes: [],
          sampledSources: 0,
          probedSources: 0,
          probedAt: new Date().toISOString(),
        };
      }

      try {
        return await runStreamProbePipeline(region);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('streamProbe job error', { jobId: job.id, region, msg });
        throw e;
      }
    },
    {
      connection: bullConnection,
      concurrency: 2,
      limiter: { max: 2, duration: 5000 },
    }
  );

  worker.on('failed', (job, err) => {
    console.error('streamProbe job failed', { jobId: job?.id, err: err?.message });
  });
}
