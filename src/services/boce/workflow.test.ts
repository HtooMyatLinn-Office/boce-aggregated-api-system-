import { BoceApiError, CreateTaskResponse, GetResultResponse } from './client';
import { runCurlDetectionWithConfig, BoceWorkflowError } from './workflow';

// Mock config module used by workflow.ts
jest.mock('../../config', () => ({
  config: {
    boce: {
      baseUrl: 'https://api.boce.com',
      apiKey: 'test-key',
    },
    detection: {
      pollIntervalMs: 1,
      pollTimeoutMs: 5,
    },
  },
}));

// Mock the client functions used inside workflow
jest.mock('./client', () => {
  const actual = jest.requireActual('./client');
  return {
    ...actual,
    createTask: jest.fn(),
    getTaskIdFromResponse: jest.fn(),
    pollResultUntilDone: jest.fn(),
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const client = require('./client') as {
  createTask: jest.Mock;
  getTaskIdFromResponse: jest.Mock;
  pollResultUntilDone: jest.Mock;
};

describe('Boce workflow (Step 4)', () => {
  beforeEach(() => {
    client.createTask.mockReset();
    client.getTaskIdFromResponse.mockReset();
    client.pollResultUntilDone.mockReset();
  });

  it('returns taskId and result on success', async () => {
    const created: CreateTaskResponse = { error_code: 0, data: { id: 't1' } };
    const result: GetResultResponse = { done: true, id: 't1', max_node: 1, list: [] };
    client.createTask.mockResolvedValue(created);
    client.getTaskIdFromResponse.mockReturnValue('t1');
    client.pollResultUntilDone.mockResolvedValue(result);

    const run = await runCurlDetectionWithConfig({ host: 'www.baidu.com', nodeIds: '31,32' });
    expect(run.taskId).toBe('t1');
    expect(run.result.done).toBe(true);
    expect(run.created).toEqual(created);
    expect(run.timings.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('maps BoceApiError errorCode=1 to AUTH_FAILED', async () => {
    client.createTask.mockRejectedValue(new BoceApiError('鉴权失败', 1, '鉴权失败'));

    await expect(
      runCurlDetectionWithConfig({ host: 'www.baidu.com', nodeIds: '31,32' })
    ).rejects.toMatchObject({ name: 'BoceWorkflowError', kind: 'AUTH_FAILED', errorCode: 1 });
  });

  it('maps polling timeout (errorCode=-2) to TIMEOUT', async () => {
    client.createTask.mockResolvedValue({ error_code: 0, data: { id: 't2' } } as CreateTaskResponse);
    client.getTaskIdFromResponse.mockReturnValue('t2');
    client.pollResultUntilDone.mockRejectedValue(new BoceApiError('timeout', -2));

    await expect(
      runCurlDetectionWithConfig({ host: 'www.baidu.com', nodeIds: '31,32' })
    ).rejects.toMatchObject({ name: 'BoceWorkflowError', kind: 'TIMEOUT', errorCode: -2 });
  });

  it('throws AUTH_FAILED if BOCE_API_KEY not set', async () => {
    jest.resetModules();
    jest.doMock('../../config', () => ({
      config: {
        boce: { baseUrl: 'https://api.boce.com', apiKey: '' },
        detection: { pollIntervalMs: 1, pollTimeoutMs: 5 },
      },
    }));
    const { runCurlDetectionWithConfig: runNoKey } = await import('./workflow');

    await expect(runNoKey({ host: 'x.com', nodeIds: '1' })).rejects.toMatchObject({
      name: 'BoceWorkflowError',
      kind: 'AUTH_FAILED',
    });
  });
});

