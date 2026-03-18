import { Router } from 'express';
import { detectOnce } from '../services/detection/detect';
import { DetectionRequest } from '../types';
import { enqueueDetection, detectQueue } from '../services/queue/detectQueue';
import { getDetectionByRequestId, listDetectionsByUrl, saveDetection } from '../services/db/detectionsRepo';
import { BoceWorkflowError } from '../services/boce';

export const detectRouter = Router();

detectRouter.post('/', async (req, res) => {
  const body = req.body as Partial<DetectionRequest>;
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (!url) {
    res.status(400).json({ success: false, error: 'Missing body.url' });
    return;
  }

  const ipWhitelist =
    Array.isArray(body.ipWhitelist) ? body.ipWhitelist.map(String) : undefined;

  const nodeIds = typeof body.nodeIds === 'string' ? body.nodeIds.trim() : undefined;

  const asyncMode = body.async === true || req.query.async === '1';

  try {
    if (asyncMode) {
      const job = await enqueueDetection({ url, ipWhitelist, nodeIds });
      res.status(202).json({
        success: true,
        mode: 'async',
        jobId: job.id,
        statusUrl: `/api/detect/jobs/${job.id}`,
      });
      return;
    }

    const result = await detectOnce({ url, ipWhitelist, nodeIds });
    // best-effort persistence
    saveDetection(result).catch(() => undefined);
    res.json({ success: true, mode: 'sync', data: result });
  } catch (e) {
    if (e instanceof BoceWorkflowError) {
      // Boce errors are user/actionable, not server errors
      res.status(400).json({
        success: false,
        error: e.message,
        kind: e.kind,
        errorCode: e.errorCode,
        boceError: e.boceError,
      });
      return;
    }
    throw e;
  }
});

detectRouter.get('/jobs/:jobId', async (req, res) => {
  const { jobId } = req.params;
  const job = await detectQueue.getJob(jobId);
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
    progress: job.progress,
    failedReason,
    result,
  });
});

detectRouter.get('/results/:requestId', async (req, res) => {
  const { requestId } = req.params;
  const found = await getDetectionByRequestId(requestId);
  if (!found) {
    res.status(404).json({ success: false, error: 'Not found' });
    return;
  }
  res.json({ success: true, data: found });
});

detectRouter.get('/history', async (req, res) => {
  const url = typeof req.query.url === 'string' ? req.query.url.trim() : '';
  if (!url) {
    res.status(400).json({ success: false, error: 'Missing query: url' });
    return;
  }
  const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 20;
  const items = await listDetectionsByUrl(url, Number.isFinite(limit) ? limit : 20);
  res.json({ success: true, url, count: items.length, items });
});

