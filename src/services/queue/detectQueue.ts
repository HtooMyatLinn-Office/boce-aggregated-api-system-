import { Queue, Worker, Job } from 'bullmq';
import { config } from '../../config';
import { DetectionRequest, DetectionResult } from '../../types';
import { detectOnce } from '../detection/detect';
import { saveDetection } from '../db/detectionsRepo';

export const DETECT_QUEUE_NAME = 'detect';

export interface DetectJobData extends DetectionRequest {}

export interface DetectJobResult extends DetectionResult {}

function parseRedisUrl(url: string): {
  host: string;
  port: number;
  password?: string;
  db?: number;
} {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 6379,
    password: u.password ? u.password : undefined,
    db: u.pathname && u.pathname !== '/' ? Number(u.pathname.slice(1)) : undefined,
  };
}

const bullConnection = parseRedisUrl(config.redis?.url ?? 'redis://localhost:6379');

export const detectQueue = new Queue<DetectJobData, DetectJobResult, string>(DETECT_QUEUE_NAME, {
  connection: bullConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { age: 60 * 60, count: 1000 }, // keep up to 1h / 1000 jobs
    removeOnFail: { age: 24 * 60 * 60, count: 1000 }, // keep failed up to 24h
  },
});

let worker: Worker<DetectJobData, DetectJobResult, string> | undefined;

export function startDetectWorker(): void {
  if (!config.queue.enabled) return;
  if (worker) return;

  worker = new Worker<DetectJobData, DetectJobResult, string>(
    DETECT_QUEUE_NAME,
    async (job: Job<DetectJobData, DetectJobResult>) => {
      // timeout is enforced by BullMQ job option; detectOnce also polls Boce with 2min cap
      const result = await detectOnce(job.data);
      // persist result for traceability
      await saveDetection(result);
      return result;
    },
    {
      connection: bullConnection,
      concurrency: Math.max(1, config.queue.concurrency),
    }
  );

  worker.on('failed', (job, err) => {
    console.error('detect job failed', { jobId: job?.id, err: err?.message });
  });
}

export async function enqueueDetection(data: DetectJobData) {
  const job = await detectQueue.add('detectOnce', data, {
    // BullMQ v5 types use `timeout` on JobOptions in runtime, but may not expose it in JobsOptions typings.
    // Cast to keep TypeScript happy; runtime will still enforce.
    ...( { timeout: config.queue.jobTimeoutMs } as unknown as Record<string, unknown> ),
  });
  return job;
}

