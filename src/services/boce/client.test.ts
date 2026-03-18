import {
  createTask,
  getTaskIdFromResponse,
  getResult,
  pollResultUntilDone,
  BoceApiError,
  CreateTaskResponse,
  GetResultResponse,
} from './client';

const BASE_URL = 'https://api.boce.com';
const KEY = 'test-key';

describe('Boce client – createTask (Step 2)', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns task id when Boce returns success (error_code 0)', async () => {
    const taskId = 'LxiB1jZPNiGZbvSYxBoVNEAfR8DhZaQ';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () =>
        ({
          error_code: 0,
          data: { id: taskId },
        }) as CreateTaskResponse,
    });

    const res = await createTask(BASE_URL, {
      key: 'test-key',
      nodeIds: '31,32',
      host: 'www.baidu.com',
    });

    expect(res.error_code).toBe(0);
    expect(res.data?.id).toBe(taskId);
    expect(getTaskIdFromResponse(res)).toBe(taskId);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toContain('/v3/task/create/curl');
    expect(url).toContain('key=test-key');
    expect(url).toContain('node_ids=31%2C32');
    expect(url).toContain('host=www.baidu.com');
  });

  it('throws BoceApiError when error_code is non-zero', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () =>
        ({
          error_code: 40001,
          error: 'Invalid key',
        }) as CreateTaskResponse,
    });

    await expect(
      createTask(BASE_URL, {
        key: 'bad-key',
        nodeIds: '31,32',
        host: 'www.baidu.com',
      })
    ).rejects.toThrow(BoceApiError);

    try {
      await createTask(BASE_URL, {
        key: 'bad-key',
        nodeIds: '31,32',
        host: 'www.baidu.com',
      });
    } catch (e) {
      expect(e).toBeInstanceOf(BoceApiError);
      expect((e as BoceApiError).errorCode).toBe(40001);
      expect((e as BoceApiError).boceError).toBe('Invalid key');
    }
  });

  it('throws when HTTP is not ok', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error_code: 500, error: 'Server Error' }) as CreateTaskResponse,
    });

    await expect(
      createTask(BASE_URL, { key: 'k', nodeIds: '31', host: 'x.com' })
    ).rejects.toThrow(BoceApiError);
  });

  it('getTaskIdFromResponse throws when data.id is missing', () => {
    expect(() =>
      getTaskIdFromResponse({ error_code: 0, data: {} as { id: string } })
    ).toThrow(BoceApiError);
    expect(() =>
      getTaskIdFromResponse({ error_code: 0 })
    ).toThrow(BoceApiError);
  });
});

describe('Boce client – getResult & pollResultUntilDone (Step 3)', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('getResult returns done and list', async () => {
    const taskId = '20260318_abc123';
    const body: GetResultResponse = {
      done: true,
      id: taskId,
      max_node: 1,
      list: [
        {
          node_id: 6,
          node_name: '河北电信',
          host: 'www.baidu.com',
          http_code: 200,
          remote_ip: '220.181.38.149',
          time_total: 0.134,
          error_code: 0,
        },
      ],
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => body,
    });

    const result = await getResult(BASE_URL, KEY, taskId);

    expect(result.done).toBe(true);
    expect(result.list).toHaveLength(1);
    expect(result.list[0].http_code).toBe(200);
    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toContain(`/v3/task/curl/${taskId}`);
    expect(url).toContain('key=test-key');
  });

  it('pollResultUntilDone returns when done is true', async () => {
    const taskId = 'poll_me';
    const body: GetResultResponse = {
      done: true,
      id: taskId,
      max_node: 1,
      list: [],
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => body,
    });

    const result = await pollResultUntilDone(BASE_URL, KEY, taskId, {
      pollIntervalMs: 10,
      pollTimeoutMs: 1000,
    });

    expect(result.done).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('pollResultUntilDone polls until done then returns', async () => {
    const taskId = 'poll_twice';
    let callCount = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () =>
          ({
            done: callCount >= 2,
            id: taskId,
            max_node: 1,
            list: callCount >= 2 ? [{ node_id: 1, http_code: 200 }] : [],
          }) as GetResultResponse,
      });
    });

    const result = await pollResultUntilDone(BASE_URL, KEY, taskId, {
      pollIntervalMs: 5,
      pollTimeoutMs: 500,
    });

    expect(result.done).toBe(true);
    expect(result.list).toHaveLength(1);
    expect((global.fetch as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('pollResultUntilDone throws after timeout if not done', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () =>
        ({
          done: false,
          id: 'x',
          max_node: 1,
          list: [],
        }) as GetResultResponse,
    });

    await expect(
      pollResultUntilDone(BASE_URL, KEY, 'never-done', {
        pollIntervalMs: 20,
        pollTimeoutMs: 50,
      })
    ).rejects.toThrow(BoceApiError);
  });
});
