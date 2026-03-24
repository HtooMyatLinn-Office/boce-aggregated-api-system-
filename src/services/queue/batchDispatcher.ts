import { config } from '../../config';
import { claimPendingDomainsForDispatch } from '../db/scanJobsRepo';
import { enqueueBatchDomainsBulk } from './batchQueue';

let timer: NodeJS.Timeout | undefined;

async function dispatchOnce() {
  const rows = await claimPendingDomainsForDispatch(config.queue.dispatchBatchSize);
  if (rows.length === 0) return;
  await enqueueBatchDomainsBulk(
    rows.map((r) => ({
      jobId: r.jobId,
      domain: r.domain,
      nodeIds: r.nodeIds,
      ipWhitelist: r.ipWhitelist,
      clientId: r.clientId,
    }))
  );
}

export function startBatchDispatcher(): void {
  if (!config.queue.enabled) return;
  if (timer) return;

  const intervalMs = Math.max(500, config.queue.dispatchIntervalMs);
  timer = setInterval(() => {
    dispatchOnce().catch((e) => {
      // keep dispatcher alive; do not throw from timer.
      console.error('batch dispatcher error', e?.message ?? e);
    });
  }, intervalMs);
  timer.unref?.();
}

