import { config } from '../../config';
import {
  createTask,
  getTaskIdFromResponse,
  getResult,
  pollResultUntilDone,
  CreateTaskParams,
  CreateTaskResponse,
  GetResultResponse,
  BoceResultListItem,
  PollOptions,
  BoceApiError,
} from './client';
import {
  BoceWorkflowError,
  BoceWorkflowErrorKind,
  RunCurlDetectionParams,
  RunCurlDetectionResult,
  runCurlDetectionWithConfig,
} from './workflow';
import {
  BoceNodeArea,
  BoceNodeListItem,
  BoceNodeListResponse,
  NodeCacheSnapshot,
  NodeMeta,
  fetchNodeList,
  nodeCache,
  refreshNodeCache,
  startNodeCacheAutoRefresh,
} from './nodes';
import { getBalance, BoceBalanceResponse } from './balance';

export {
  createTask,
  getTaskIdFromResponse,
  getResult,
  pollResultUntilDone,
  BoceApiError,
  runCurlDetectionWithConfig,
  BoceWorkflowError,
  fetchNodeList,
  nodeCache,
  refreshNodeCache,
  startNodeCacheAutoRefresh,
  getBalance,
};
export type {
  CreateTaskParams,
  CreateTaskResponse,
  GetResultResponse,
  BoceResultListItem,
  PollOptions,
  BoceWorkflowErrorKind,
  RunCurlDetectionParams,
  RunCurlDetectionResult,
  BoceNodeArea,
  BoceNodeListItem,
  BoceNodeListResponse,
  NodeMeta,
  NodeCacheSnapshot,
  BoceBalanceResponse,
};

/**
 * Create a Boce detection task using app config (baseUrl, apiKey).
 */
export async function createTaskWithConfig(
  host: string,
  nodeIds: string,
  nodeType?: string
): Promise<CreateTaskResponse> {
  const key = config.boce.apiKey;
  if (!key) {
    throw new BoceApiError('BOCE_API_KEY is not set', -1);
  }
  return createTask(config.boce.baseUrl, {
    key,
    nodeIds,
    host,
    nodeType,
  });
}

/**
 * Get task result once (done may be false). Uses app config.
 */
export async function getResultWithConfig(taskId: string): Promise<GetResultResponse> {
  const key = config.boce.apiKey;
  if (!key) {
    throw new BoceApiError('BOCE_API_KEY is not set', -1);
  }
  return getResult(config.boce.baseUrl, key, taskId);
}

/**
 * Poll until done (every ~10s, max 2 min). Uses app config.
 */
export async function pollResultUntilDoneWithConfig(
  taskId: string,
  options?: PollOptions
): Promise<GetResultResponse> {
  const key = config.boce.apiKey;
  if (!key) {
    throw new BoceApiError('BOCE_API_KEY is not set', -1);
  }
  return pollResultUntilDone(config.boce.baseUrl, key, taskId, {
    pollIntervalMs: config.detection.pollIntervalMs,
    pollTimeoutMs: config.detection.pollTimeoutMs,
    ...options,
  });
}

export async function getBalanceWithConfig(): Promise<BoceBalanceResponse> {
  const key = config.boce.apiKey;
  if (!key) {
    throw new BoceApiError('BOCE_API_KEY is not set', -1);
  }
  return getBalance(config.boce.baseUrl, key);
}

// Re-export workflow types (for external callers)
export type {
  BoceWorkflowErrorKind as WorkflowErrorKind,
  RunCurlDetectionParams as WorkflowRunParams,
  RunCurlDetectionResult as WorkflowRunResult,
};
