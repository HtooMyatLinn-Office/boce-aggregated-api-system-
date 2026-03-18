import { BoceApiError } from './client';
import { fetchNodeList, nodeCache, refreshNodeCache } from './nodes';

jest.mock('../../config', () => ({
  config: {
    boce: { baseUrl: 'https://api.boce.com', apiKey: 'test-key' },
    nodes: { refreshIntervalHours: 6 },
  },
}));

describe('Boce nodes (Step 5)', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('fetchNodeList hits /v3/node/list with key and area', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        error_code: 0,
        data: { list: [{ id: 6, node_name: '河北', isp_name: '电信', isp_code: 100017 }] },
      }),
    });

    const res = await fetchNodeList('https://api.boce.com', 'k', 'oversea');
    expect(res.error_code).toBe(0);

    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toContain('/v3/node/list');
    expect(url).toContain('key=k');
    expect(url).toContain('area=oversea');
  });

  it('fetchNodeList throws BoceApiError when error_code != 0', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ error_code: 1, error: '鉴权失败' }),
    });

    await expect(fetchNodeList('https://api.boce.com', 'bad', 'mainland')).rejects.toBeInstanceOf(BoceApiError);
  });

  it('refreshNodeCache updates cache and supports lookup', async () => {
    let call = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      call++;
      if (call === 1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            error_code: 0,
            data: { list: [{ id: 31, node_name: '福建移动', isp_name: '移动', isp_code: 100025 }] },
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          error_code: 0,
          data: { list: [{ id: 999, node_name: 'US-1', isp_name: 'ISP', isp_code: 999 }] },
        }),
      });
    });

    const snap = await refreshNodeCache();
    expect(snap.total).toBe(2);

    const n31 = nodeCache.getNode(31);
    expect(n31?.region).toBe('CN');
    const n999 = nodeCache.getNode(999);
    expect(n999?.region).toBe('Global');
  });
});

