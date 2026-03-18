import { Router, Request, Response } from 'express';
import {
  createTaskWithConfig,
  getTaskIdFromResponse,
  getResultWithConfig,
  pollResultUntilDoneWithConfig,
  BoceApiError,
  BoceWorkflowError,
  runCurlDetectionWithConfig,
  nodeCache,
  refreshNodeCache,
} from '../services/boce';
import { config } from '../config';

export const devRouter = Router();

/** Check that app sees BOCE_API_KEY (masked). Use to verify Docker/env. */
devRouter.get('/check-env', (_req: Request, res: Response) => {
  const key = config.boce.apiKey;
  res.json({
    boceKeySet: !!key,
    boceKeyLength: key ? key.length : 0,
    boceBaseUrl: config.boce.baseUrl,
  });
});

/** Only mount in development – Step 2 manual test: create Boce task and return task id */
devRouter.get('/create-task', async (req: Request, res: Response) => {
  const host = (req.query.host as string)?.trim();
  const nodeIds = (req.query.node_ids as string)?.trim() || '31,32';

  if (!host) {
    res.status(400).json({ error: 'Missing query: host (e.g. ?host=www.baidu.com)' });
    return;
  }

  try {
    const response = await createTaskWithConfig(host, nodeIds);
    const taskId = getTaskIdFromResponse(response);
    res.json({
      success: true,
      taskId,
      error_code: response.error_code,
      message: 'Use this taskId in Step 3 to poll for result',
    });
  } catch (e) {
    if (e instanceof BoceApiError) {
      const payload: Record<string, unknown> = {
        success: false,
        error: e.message,
        errorCode: e.errorCode,
        boceError: e.boceError,
      };
      if (e.errorCode === 4) {
        payload.hints = [
          '1. 波点不足：控制台检查「可用波点」是否 > 0，不足请充值。',
          '2. 未开通网站检测：控制台 → API管理 → API接口，确认已对「网站检测/HTTP检测」免费申请。',
          '3. Key 未开启：在「网站检测」的【设置】里，开启「统一Key」或「独立Key」并确认使用的是该 key。',
          '4. 调用IP 限制：若设置了「调用IP」，请留空或加入当前出口 IP 后再试。',
          '5. 用浏览器直接测：https://api.boce.com/v3/task/create/curl?key=你的key&node_ids=31,32&host=www.baidu.com 看是否同样报错。',
        ];
      }
      res.status(400).json(payload);
      return;
    }
    throw e;
  }
});

/** Step 3: get result once (done may be false). */
devRouter.get('/get-result', async (req: Request, res: Response) => {
  const taskId = (req.query.taskId as string)?.trim();
  if (!taskId) {
    res.status(400).json({ error: 'Missing query: taskId (from create-task response)' });
    return;
  }
  try {
    const result = await getResultWithConfig(taskId);
    res.json({ success: true, ...result });
  } catch (e) {
    if (e instanceof BoceApiError) {
      res.status(400).json({
        success: false,
        error: e.message,
        errorCode: e.errorCode,
      });
      return;
    }
    throw e;
  }
});

/** Step 3: poll until done (~10s interval, 2 min max), then return full result. */
devRouter.get('/poll-result', async (req: Request, res: Response) => {
  const taskId = (req.query.taskId as string)?.trim();
  if (!taskId) {
    res.status(400).json({ error: 'Missing query: taskId (from create-task response)' });
    return;
  }
  try {
    const result = await pollResultUntilDoneWithConfig(taskId);
    res.json({
      success: true,
      done: result.done,
      taskId: result.id,
      max_node: result.max_node,
      list: result.list,
      message: 'Step 3 complete. Use list for metrics in later steps.',
    });
  } catch (e) {
    if (e instanceof BoceApiError) {
      res.status(400).json({
        success: false,
        error: e.message,
        errorCode: e.errorCode,
      });
      return;
    }
    throw e;
  }
});

/** Step 4: one-call create + poll. */
devRouter.get('/run-detection', async (req: Request, res: Response) => {
  const host = (req.query.host as string)?.trim();
  const nodeIds = (req.query.node_ids as string)?.trim() || '31,32';

  if (!host) {
    res.status(400).json({ error: 'Missing query: host (e.g. ?host=www.baidu.com)' });
    return;
  }

  try {
    const run = await runCurlDetectionWithConfig({ host, nodeIds });
    res.json({
      success: true,
      taskId: run.taskId,
      done: run.result.done,
      max_node: run.result.max_node,
      list: run.result.list,
      timings: run.timings,
      message: 'Step 4 complete (create + poll in one call).',
    });
  } catch (e) {
    if (e instanceof BoceWorkflowError) {
      res.status(400).json({
        success: false,
        kind: e.kind,
        errorCode: e.errorCode,
        error: e.message,
        boceError: e.boceError,
      });
      return;
    }
    if (e instanceof BoceApiError) {
      res.status(400).json({
        success: false,
        errorCode: e.errorCode,
        error: e.message,
        boceError: e.boceError,
      });
      return;
    }
    throw e;
  }
});

/** Step 5: node cache snapshot (in-memory) */
devRouter.get('/nodes', async (_req: Request, res: Response) => {
  res.json({ success: true, snapshot: nodeCache.snapshot() });
});

/** Step 5: refresh node cache now (mainland + oversea) */
devRouter.post('/nodes/refresh', async (_req: Request, res: Response) => {
  try {
    const snapshot = await refreshNodeCache();
    res.json({ success: true, snapshot });
  } catch (e) {
    if (e instanceof BoceApiError) {
      res.status(400).json({ success: false, errorCode: e.errorCode, error: e.message });
      return;
    }
    throw e;
  }
});

/** Step 5: lookup node metadata by nodeId */
devRouter.get('/nodes/lookup', async (req: Request, res: Response) => {
  const raw = (req.query.nodeId as string)?.trim();
  const nodeId = raw ? Number(raw) : NaN;
  if (!raw || Number.isNaN(nodeId)) {
    res.status(400).json({ error: 'Missing/invalid query: nodeId (e.g. ?nodeId=31)' });
    return;
  }
  const node = nodeCache.getNode(nodeId);
  if (!node) {
    res.status(404).json({ success: false, error: 'Node not found in cache. Try POST /api/dev/nodes/refresh' });
    return;
  }
  res.json({ success: true, node });
});

export function mountDevRoutes(app: import('express').Express): void {
  if (config.nodeEnv !== 'development') return;
  app.use('/api/dev', devRouter);
}
