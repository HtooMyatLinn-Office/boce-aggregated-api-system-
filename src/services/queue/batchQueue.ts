import { Queue, Worker, Job } from 'bullmq';
import { config } from '../../config';
import { parseRedisUrl } from './util';
import { DetectionResult } from '../../types';
import { detectOnce } from '../detection/detect';
import { saveDetection } from '../db/detectionsRepo';
import {
  claimFinalizedJobWebhook,
  markDomainCompleted,
  markDomainFailed,
  markDomainRunning,
} from '../db/scanJobsRepo';
import { sendBatchCompletedWebhook } from '../webhook/batchWebhook';

export const BATCH_DOMAIN_QUEUE_NAME = 'batch-domain';

export interface BatchDomainJobData {
  jobId: string;
  domain: string;
  nodeIds: string;
  ipWhitelist?: string[];
  clientId?: string;
}

export interface BatchDomainJobResult {
  ok: boolean;
  requestId?: string;
}

const bullConnection = parseRedisUrl(config.redis?.url ?? 'redis://localhost:6379');

export const batchDomainQueue = new Queue<BatchDomainJobData, BatchDomainJobResult, string>(
  BATCH_DOMAIN_QUEUE_NAME,
  {
    connection: bullConnection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 24 * 60 * 60, count: 10000 },
      removeOnFail: { age: 24 * 60 * 60, count: 10000 },
    },
  }
);

let worker: Worker<BatchDomainJobData, BatchDomainJobResult, string> | undefined;

export function startBatchDomainWorker(): void {
  if (!config.queue.enabled) return;
  if (worker) return;

  worker = new Worker<BatchDomainJobData, BatchDomainJobResult, string>(
    BATCH_DOMAIN_QUEUE_NAME,
    async (job: Job<BatchDomainJobData, BatchDomainJobResult>) => {
      const { jobId, domain, nodeIds, ipWhitelist, clientId } = job.data;

      const runningClaimed = await markDomainRunning({ jobId, domain });
      if (!runningClaimed) return { ok: true };

      // detectOnce already performs points-safe and returns normalized/metrics/anomalies
      const result: DetectionResult = await detectOnce({ url: domain, nodeIds, ipWhitelist });

      await saveDetection(result, clientId);

      await markDomainCompleted({
        jobId,
        domain,
        requestId: result.requestId,
        taskId: result.taskId,
      });

      const webhookClaim = await claimFinalizedJobWebhook(jobId);
      if (webhookClaim) {
        await sendBatchCompletedWebhook({
          jobId,
          webhookUrl: webhookClaim.webhookUrl,
          payload: webhookClaim.payload,
        });
      }

      return { ok: true, requestId: result.requestId };
    },
    {
      connection: bullConnection,
      concurrency: Math.max(1, config.queue.concurrency),
    }
  );

  worker.on('failed', async (job, err) => {
    const data = job?.data;
    if (!data) return;
    const lastError = err?.message ?? 'unknown error';
    await markDomainFailed({ jobId: data.jobId, domain: data.domain, lastError });
    const webhookClaim = await claimFinalizedJobWebhook(data.jobId);
    if (webhookClaim) {
      await sendBatchCompletedWebhook({
        jobId: data.jobId,
        webhookUrl: webhookClaim.webhookUrl,
        payload: webhookClaim.payload,
      });
    }
  });
}

/** Add a single domain job (e.g. for retries). */
export async function enqueueBatchDomain(data: BatchDomainJobData) {
  const job = await batchDomainQueue.add('batchDomain', data);
  return job;
}

const BULK_CHUNK_SIZE = 1000;

/**
 * Enqueue many domain jobs in bulk (task scheduling for 100–5000 domains).
 * Uses BullMQ addBulk in chunks to avoid a single huge Redis pipeline;
 * API returns quickly after job creation and enqueue.
 */
export async function enqueueBatchDomainsBulk(data: BatchDomainJobData[]): Promise<void> {
  for (let i = 0; i < data.length; i += BULK_CHUNK_SIZE) {
    const chunk = data.slice(i, i + BULK_CHUNK_SIZE);
    await batchDomainQueue.addBulk(
      chunk.map((d) => ({ name: 'batchDomain' as const, data: d }))
    );
  }
}

