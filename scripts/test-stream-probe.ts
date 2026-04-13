/**
 * Manual trigger: enqueue a stream-probe job for a region (no inter-job delay).
 *
 * Usage: npm run test:stream-probe -- guangdong
 */

import dotenv from 'dotenv';

dotenv.config();

async function main(): Promise<void> {
  const { enqueueStreamProbeJob } = await import('../src/services/queue/streamProbe/queue');
  const region = process.argv[2]?.trim() || 'guangdong';
  const job = await enqueueStreamProbeJob({ region }, { delayMs: 0 });
  console.log('Enqueued stream-probe job', { jobId: job.id, region });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
