import express from 'express';
import crypto from 'crypto';
import { config } from '../config';
import { getBalanceWithConfig } from '../services/boce';
import {
  BatchDetectJobResponse,
  BatchDetectRequest,
  BatchDetectJobStatusResponse,
  ScanDomainItemStatus,
} from '../types';
import {
  cancelScanJob,
  createScanJob,
  getScanJobStatus,
  listScanJobItems,
  pauseScanJob,
  resumeScanJob,
  setScanJobPriority,
} from '../services/db/scanJobsRepo';
import {
  attachIdempotencyJob,
  IdempotencyConflictError,
  reserveBatchIdempotency,
} from '../services/db/batchIdempotencyRepo';

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

  const clientId = client?.clientId ?? 'public';
  const idempotencyKeyRaw =
    (typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined) ??
    req.header('X-Idempotency-Key') ??
    undefined;
  const idempotencyKey = idempotencyKeyRaw?.trim() || undefined;
  const requestHash = hashBatchRequest({
    domains,
    nodeIds,
    ipWhitelist: body.ipWhitelist,
    webhookUrl,
    clientId,
  });

  if (idempotencyKey) {
    try {
      const idem = await reserveBatchIdempotency({
        clientId,
        idemKey: idempotencyKey,
        requestHash,
      });
      if (idem.existingJobId) {
        const statusUrl = `/api/batch-detect/${idem.existingJobId}`;
        return res.json({
          success: true,
          replayed: true,
          jobId: idem.existingJobId,
          statusUrl,
        });
      }
    } catch (e) {
      if (e instanceof IdempotencyConflictError) {
        return res.status(409).json({ success: false, error: e.message });
      }
      throw e;
    }
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
    clientId: clientId ?? (typeof body.clientId === 'string' ? body.clientId : undefined),
  });

  if (idempotencyKey) {
    await attachIdempotencyJob({
      clientId,
      idemKey: idempotencyKey,
      requestHash,
      jobId: job.jobId,
    });
  }

  // DB-first scheduling: dispatcher will fetch PENDING rows by priority and enqueue to Redis.

  const statusUrl = `/api/batch-detect/${job.jobId}`;
  const response: BatchDetectJobResponse = {
    jobId: job.jobId,
    estimatedPoints,
    totalItems: domains.length,
    statusUrl,
  };
  return res.json({ success: true, ...response });
});

batchDetectRouter.post('/:jobId/pause', async (req, res) => {
  const ok = await pauseScanJob(req.params.jobId);
  if (!ok) return res.status(404).json({ success: false, error: 'job not found or not pausable' });
  return res.json({ success: true, jobId: req.params.jobId, status: 'PAUSED' });
});

batchDetectRouter.post('/:jobId/resume', async (req, res) => {
  const ok = await resumeScanJob(req.params.jobId);
  if (!ok) return res.status(404).json({ success: false, error: 'job not found or not resumable' });
  return res.json({ success: true, jobId: req.params.jobId, status: 'PENDING' });
});

batchDetectRouter.post('/:jobId/cancel', async (req, res) => {
  const ok = await cancelScanJob(req.params.jobId);
  if (!ok) return res.status(404).json({ success: false, error: 'job not found or not cancellable' });
  return res.json({ success: true, jobId: req.params.jobId, status: 'CANCELLED' });
});

batchDetectRouter.post('/:jobId/priority', async (req, res) => {
  const pRaw = (req.body as { priority?: number })?.priority;
  const priority = typeof pRaw === 'number' ? pRaw : Number(pRaw);
  if (!Number.isFinite(priority)) {
    return res.status(400).json({ success: false, error: 'priority must be a number' });
  }
  const ok = await setScanJobPriority(req.params.jobId, priority);
  if (!ok) return res.status(404).json({ success: false, error: 'job not found' });
  return res.json({ success: true, jobId: req.params.jobId, priority: Math.trunc(priority) });
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

function hashBatchRequest(params: {
  domains: string[];
  nodeIds: string;
  ipWhitelist?: string[];
  webhookUrl?: string;
  clientId: string;
}): string {
  const normalized = {
    domains: [...params.domains].sort(),
    nodeIds: params.nodeIds,
    ipWhitelist: [...(params.ipWhitelist ?? [])].sort(),
    webhookUrl: params.webhookUrl ?? '',
    clientId: params.clientId,
  };
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

batchDetectRouter.get('/:jobId/items', async (req, res) => {
  const jobId = req.params.jobId;

  const statusParam = req.query.status;
  const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;

  const allowed: ScanDomainItemStatus[] = ['PENDING', 'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'];
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

