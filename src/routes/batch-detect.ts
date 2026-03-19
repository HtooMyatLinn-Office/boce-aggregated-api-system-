import express from 'express';
import { config } from '../config';
import { getBalanceWithConfig } from '../services/boce';
import {
  BatchDetectJobResponse,
  BatchDetectRequest,
  BatchDetectJobStatusResponse,
  ScanDomainItemStatus,
} from '../types';
import {
  createScanJob,
  getScanJobStatus,
  listScanJobItems,
} from '../services/db/scanJobsRepo';
import { enqueueBatchDomainsBulk } from '../services/queue/batchQueue';

export const batchDetectRouter = express.Router();

function parseNodeIds(nodeIds: string): { nodeIdsStr: string; count: number } {
  const normalized = nodeIds
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (normalized.length === 0) {
    throw new Error('nodeIds is empty');
  }
  return { nodeIdsStr: normalized.join(','), count: normalized.length };
}

function parseDomains(domains: unknown): string[] {
  if (!Array.isArray(domains)) return [];
  return domains.map(String).map((d) => d.trim()).filter(Boolean);
}

function parseWebhookUrl(webhookUrl: unknown): string | undefined {
  if (typeof webhookUrl !== 'string') return undefined;
  const v = webhookUrl.trim();
  if (!v) return undefined;
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    return v;
  } catch {
    return undefined;
  }
}

batchDetectRouter.post('/', async (req, res) => {
  const body = req.body as Partial<BatchDetectRequest>;
  const client = req.authClient;

  const domains = parseDomains(body.domains);
  if (domains.length === 0) return res.status(400).json({ success: false, error: '`domains` is required' });
  const maxBatchSize = Math.max(1, Math.min(client?.maxBatchSize ?? 5000, 5000));
  if (domains.length > maxBatchSize) {
    return res.status(400).json({ success: false, error: `too many domains (max ${maxBatchSize})` });
  }

  const nodeIdsRaw = typeof body.nodeIds === 'string' ? body.nodeIds : '';
  let nodeIds: string;
  let nodesPerTask: number;
  try {
    const parsed = parseNodeIds(nodeIdsRaw);
    nodeIds = parsed.nodeIdsStr;
    nodesPerTask = parsed.count;
  } catch (e) {
    return res.status(400).json({ success: false, error: 'invalid `nodeIds`' });
  }

  // task-level webhook has highest priority, then app-level default config
  const webhookUrl =
    parseWebhookUrl(body.webhookUrl) ??
    parseWebhookUrl(client?.defaultWebhookUrl) ??
    parseWebhookUrl(config.integrations.webhookUrl);
  if (body.webhookUrl && !webhookUrl) {
    return res.status(400).json({ success: false, error: 'invalid `webhookUrl`' });
  }

  // predictable-fee: 1 node = 1 point per domain task
  const estimatedPoints = domains.length * nodesPerTask;

  // Pre-check points so we can fail fast (race conditions still exist; items may fail if points change).
  let balance;
  try {
    balance = await getBalanceWithConfig();
  } catch (e) {
    return res.status(502).json({ success: false, error: 'Failed to query BOCE balance' });
  }
  if (!balance?.data || typeof balance.data.point !== 'number') {
    return res.status(502).json({ success: false, error: 'BOCE balance response missing `point`' });
  }
  if (balance.data.point < estimatedPoints) {
    return res.status(402).json({
      success: false,
      error: 'Insufficient BOCE points',
      point: balance.data.point,
      estimatedPoints,
    });
  }

  // In this first version: we treat each domain as one Boce detection task (using the provided nodeIds).
  const job = await createScanJob({
    domains,
    nodeIds,
    nodesPerTask,
    estimatedPoints,
    ipWhitelist: body.ipWhitelist,
    webhookUrl,
    clientId: client?.clientId ?? (typeof body.clientId === 'string' ? body.clientId : undefined),
  });

  // Task scheduling: bulk enqueue so 5000 domains don't block the API (no 5k sequential Redis calls).
  await enqueueBatchDomainsBulk(
    domains.map((domain) => ({
      jobId: job.jobId,
      domain,
      nodeIds,
      ipWhitelist: body.ipWhitelist,
    }))
  );

  const statusUrl = `/api/batch-detect/${job.jobId}`;
  const response: BatchDetectJobResponse = {
    jobId: job.jobId,
    estimatedPoints,
    totalItems: domains.length,
    statusUrl,
  };
  return res.json({ success: true, ...response });
});

batchDetectRouter.get('/:jobId', async (req, res) => {
  const jobId = req.params.jobId;
  try {
    const status: BatchDetectJobStatusResponse = await getScanJobStatus(jobId);
    return res.json({ success: true, ...status });
  } catch (e) {
    return res.status(404).json({ success: false, error: 'job not found' });
  }
});

batchDetectRouter.get('/:jobId/items', async (req, res) => {
  const jobId = req.params.jobId;

  const statusParam = req.query.status;
  const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;

  const allowed: ScanDomainItemStatus[] = ['PENDING', 'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED'];
  const status = typeof statusParam === 'string' && allowed.includes(statusParam as ScanDomainItemStatus)
    ? (statusParam as ScanDomainItemStatus)
    : undefined;

  try {
    const items = await listScanJobItems({ jobId, status, limit });
    return res.json({ success: true, items });
  } catch (e) {
    return res.status(404).json({ success: false, error: 'job not found' });
  }
});

