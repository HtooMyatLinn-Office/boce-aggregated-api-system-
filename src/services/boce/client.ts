/**
 * Boce API client.
 * Step 2: createTask – create detection task, return task id.
 * Step 3: getResult + poll until done (every ~10s, max 2 min).
 * @see https://www.boce.com/document/api/137/12
 * @see https://www.boce.com/document/api/137/42
 */

const BOCE_CREATE_PATH = '/v3/task/create/curl';
const BOCE_RESULT_PATH = '/v3/task/curl';

export interface CreateTaskParams {
  key: string;
  nodeIds: string;
  host: string;
  nodeType?: string;
}

export interface CreateTaskResponse {
  error_code: number;
  error?: string;
  data?: { id: string };
}

/** Thrown when Boce API returns error_code !== 0 or HTTP error */
export class BoceApiError extends Error {
  constructor(
    message: string,
    public readonly errorCode: number,
    public readonly boceError?: string
  ) {
    super(message);
    this.name = 'BoceApiError';
  }
}

/**
 * Create a Boce detection task (website/curl check).
 * @returns API response; check error_code and data.id
 * @throws BoceApiError when error_code !== 0 or network/HTTP failure
 */
export async function createTask(
  baseUrl: string,
  params: CreateTaskParams
): Promise<CreateTaskResponse> {
  const url = new URL(BOCE_CREATE_PATH, baseUrl);
  url.searchParams.set('key', params.key);
  url.searchParams.set('node_ids', params.nodeIds);
  url.searchParams.set('host', params.host);
  if (params.nodeType) url.searchParams.set('node_type', params.nodeType);

  let res: Response;
  let body: CreateTaskResponse;
  try {
    res = await fetch(url.toString(), { method: 'GET' });
    body = (await res.json()) as CreateTaskResponse;
  } catch (e) {
    throw new BoceApiError(
      e instanceof Error ? e.message : 'Network request failed',
      -1
    );
  }

  if (!res.ok) {
    throw new BoceApiError(
      body?.error ?? `HTTP ${res.status}`,
      body?.error_code ?? res.status,
      body?.error
    );
  }

  if (body.error_code !== 0) {
    throw new BoceApiError(
      body.error ?? 'Boce API error',
      body.error_code,
      body.error
    );
  }

  return body;
}

/**
 * Extract task id from a successful create response.
 * Use after createTask() when error_code is 0.
 */
export function getTaskIdFromResponse(response: CreateTaskResponse): string {
  if (!response.data?.id) {
    throw new BoceApiError('Missing task id in response', response.error_code ?? -1);
  }
  return response.data.id;
}

// --- Get result (Step 3) ---

export interface BoceResultListItem {
  node_id: number;
  node_name: string;
  host: string;
  origin_ip?: string;
  remote_ip?: string;
  ip_region?: string;
  ip_isp?: string;
  http_code?: number;
  error_code?: number;
  error?: string;
  time_total?: number;
  time_namelookup?: number;
  time_connect?: number;
  time_starttransfer?: number;
  size_download?: number;
  speed_download?: number;
  download_time?: number;
  report_source?: string;
  session_id?: string;
  time_id?: string;
  page_load?: string;
}

export interface GetResultResponse {
  done: boolean;
  id: string;
  list: BoceResultListItem[];
  max_node: number;
}

/**
 * Get task result (website/curl). done may be false if not finished yet.
 * @see https://www.boce.com/document/api/137/42
 */
export async function getResult(
  baseUrl: string,
  key: string,
  taskId: string
): Promise<GetResultResponse> {
  const path = `${BOCE_RESULT_PATH}/${encodeURIComponent(taskId)}`;
  const url = new URL(path, baseUrl);
  url.searchParams.set('key', key);

  let res: Response;
  let body: GetResultResponse;
  try {
    res = await fetch(url.toString(), { method: 'GET' });
    body = (await res.json()) as GetResultResponse;
  } catch (e) {
    throw new BoceApiError(
      e instanceof Error ? e.message : 'Network request failed',
      -1
    );
  }

  if (!res.ok) {
    throw new BoceApiError(
      `HTTP ${res.status}`,
      res.status
    );
  }

  return body;
}

export interface PollOptions {
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

/**
 * Poll getResult until done is true or timeout. Recommend poll every ~10s, stop after 2 min.
 */
export async function pollResultUntilDone(
  baseUrl: string,
  key: string,
  taskId: string,
  options: PollOptions = {}
): Promise<GetResultResponse> {
  const intervalMs = options.pollIntervalMs ?? 10_000;
  const timeoutMs = options.pollTimeoutMs ?? 120_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await getResult(baseUrl, key, taskId);
    if (result.done) return result;
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  const last = await getResult(baseUrl, key, taskId);
  if (last.done) return last;
  throw new BoceApiError(
    `Task ${taskId} did not complete within ${timeoutMs}ms`,
    -2
  );
}
