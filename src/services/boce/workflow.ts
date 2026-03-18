import { config } from '../../config';
import {
  BoceApiError,
  CreateTaskResponse,
  GetResultResponse,
  createTask,
  getTaskIdFromResponse,
  pollResultUntilDone,
} from './client';

export type BoceWorkflowErrorKind =
  | 'AUTH_FAILED'
  | 'PARAM_ERROR'
  | 'INSUFFICIENT_POINTS'
  | 'TASK_ID_FAILED_OR_EXPIRED'
  | 'NODE_ERROR'
  | 'TIMEOUT'
  | 'HTTP_ERROR'
  | 'NETWORK_ERROR'
  | 'UNKNOWN';

export class BoceWorkflowError extends Error {
  constructor(
    message: string,
    public readonly kind: BoceWorkflowErrorKind,
    public readonly errorCode?: number,
    public readonly boceError?: string
  ) {
    super(message);
    this.name = 'BoceWorkflowError';
  }
}

function mapBoceErrorKind(errorCode: number): BoceWorkflowErrorKind {
  // https://www.boce.com/document/api/70/73
  switch (errorCode) {
    case 1:
      return 'AUTH_FAILED';
    case 2:
      return 'PARAM_ERROR';
    case 3:
      return 'INSUFFICIENT_POINTS';
    case 4:
      return 'TASK_ID_FAILED_OR_EXPIRED';
    case -1:
      return 'NODE_ERROR';
    default:
      return 'UNKNOWN';
  }
}

export interface RunCurlDetectionParams {
  host: string;
  nodeIds: string;
  nodeType?: string;
}

export interface RunCurlDetectionResult {
  taskId: string;
  created: CreateTaskResponse;
  result: GetResultResponse;
  timings: {
    startedAt: string;
    finishedAt: string;
    elapsedMs: number;
  };
}

/**
 * Step 4: One-call workflow.
 * - create Boce task
 * - poll result until done (10s) or timeout (2 min)
 */
export async function runCurlDetectionWithConfig(
  params: RunCurlDetectionParams
): Promise<RunCurlDetectionResult> {
  const key = config.boce.apiKey;
  if (!key) {
    throw new BoceWorkflowError('BOCE_API_KEY is not set', 'AUTH_FAILED', 1);
  }

  const startedAt = Date.now();
  try {
    const created = await createTask(config.boce.baseUrl, {
      key,
      nodeIds: params.nodeIds,
      host: params.host,
      nodeType: params.nodeType,
    });

    const taskId = getTaskIdFromResponse(created);
    const result = await pollResultUntilDone(config.boce.baseUrl, key, taskId, {
      pollIntervalMs: config.detection.pollIntervalMs,
      pollTimeoutMs: config.detection.pollTimeoutMs,
    });

    const finishedAt = Date.now();
    return {
      taskId,
      created,
      result,
      timings: {
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date(finishedAt).toISOString(),
        elapsedMs: finishedAt - startedAt,
      },
    };
  } catch (e) {
    if (e instanceof BoceApiError) {
      // -2 is our local polling timeout code
      if (e.errorCode === -2) {
        throw new BoceWorkflowError(e.message, 'TIMEOUT', e.errorCode, e.boceError);
      }
      if (e.errorCode === -1) {
        throw new BoceWorkflowError(e.message, 'NETWORK_ERROR', e.errorCode, e.boceError);
      }
      const kind = mapBoceErrorKind(e.errorCode);
      throw new BoceWorkflowError(e.message, kind, e.errorCode, e.boceError);
    }
    throw e;
  }
}

