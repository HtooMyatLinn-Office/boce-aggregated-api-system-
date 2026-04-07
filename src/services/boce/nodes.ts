import { config } from '../../config';
import { BoceApiError } from './client';

const BOCE_NODE_LIST_PATH = '/v3/node/list';

export type BoceNodeArea = 'mainland' | 'oversea';

export interface BoceNodeListItem {
  id: number;
  node_name: string;
  isp_name: string;
  isp_code: number;
}

export interface BoceNodeListResponse {
  error_code: number;
  error?: string;
  data?: {
    list?: BoceNodeListItem[];
  };
}

export async function fetchNodeList(
  baseUrl: string,
  key: string,
  area: BoceNodeArea = 'mainland'
): Promise<BoceNodeListResponse> {
  const url = new URL(BOCE_NODE_LIST_PATH, baseUrl);
  url.searchParams.set('key', key);
  if (area === 'oversea') url.searchParams.set('area', 'oversea');

  let res: Response;
  let body: BoceNodeListResponse;
  try {
    res = await fetch(url.toString(), { method: 'GET' });
    body = (await res.json()) as BoceNodeListResponse;
  } catch (e) {
    throw new BoceApiError(e instanceof Error ? e.message : 'Network request failed', -1);
  }

  if (!res.ok) {
    throw new BoceApiError(body?.error ?? `HTTP ${res.status}`, body?.error_code ?? res.status, body?.error);
  }
  if (body.error_code !== 0) {
    throw new BoceApiError(body.error ?? 'Boce API error', body.error_code, body.error);
  }
  return body;
}

export interface NodeMeta {
  id: number;
  nodeName: string;
  ispName: string;
  ispCode: number;
  area: BoceNodeArea;
  region: 'CN' | 'Global';
}

function toRegion(area: BoceNodeArea): 'CN' | 'Global' {
  return area === 'mainland' ? 'CN' : 'Global';
}

export interface NodeCacheSnapshot {
  updatedAt?: string;
  mainlandCount: number;
  overseaCount: number;
  total: number;
}

class InMemoryNodeCache {
  private byId = new Map<number, NodeMeta>();
  private updatedAt?: Date;
  private refreshTimer?: NodeJS.Timeout;

  snapshot(): NodeCacheSnapshot {
    const all = Array.from(this.byId.values());
    const mainlandCount = all.filter((n) => n.area === 'mainland').length;
    const overseaCount = all.filter((n) => n.area === 'oversea').length;
    return {
      updatedAt: this.updatedAt?.toISOString(),
      mainlandCount,
      overseaCount,
      total: all.length,
    };
  }

  getNode(id: number): NodeMeta | undefined {
    return this.byId.get(id);
  }

  listNodes(): NodeMeta[] {
    return Array.from(this.byId.values()).sort((a, b) => a.id - b.id);
  }

  upsertAll(nodes: NodeMeta[], updatedAt: Date): void {
    for (const n of nodes) this.byId.set(n.id, n);
    this.updatedAt = updatedAt;
  }

  startAutoRefresh(fn: () => Promise<unknown>, intervalHours: number): void {
    if (this.refreshTimer) return; // already started
    const intervalMs = Math.max(1, intervalHours) * 60 * 60 * 1000;
    // refresh shortly after boot, then every N hours; fail-open on refresh errors.
    void fn().catch((e) => {
      console.warn('node cache initial refresh failed:', e instanceof Error ? e.message : e);
    });
    this.refreshTimer = setInterval(() => {
      void fn().catch((e) => {
        console.warn('node cache periodic refresh failed:', e instanceof Error ? e.message : e);
      });
    }, intervalMs);
    this.refreshTimer.unref?.();
  }
}

export const nodeCache = new InMemoryNodeCache();

export async function refreshNodeCache(): Promise<NodeCacheSnapshot> {
  const key = config.boce.apiKey;
  if (!key) throw new BoceApiError('BOCE_API_KEY is not set', 1);

  const updatedAt = new Date();
  const mainland = await fetchNodeList(config.boce.baseUrl, key, 'mainland');
  const oversea = await fetchNodeList(config.boce.baseUrl, key, 'oversea');

  const mainlandList = mainland.data?.list ?? [];
  const overseaList = oversea.data?.list ?? [];

  const metas: NodeMeta[] = [
    ...mainlandList.map((n) => ({
      id: n.id,
      nodeName: n.node_name,
      ispName: n.isp_name,
      ispCode: n.isp_code,
      area: 'mainland' as const,
      region: toRegion('mainland'),
    })),
    ...overseaList.map((n) => ({
      id: n.id,
      nodeName: n.node_name,
      ispName: n.isp_name,
      ispCode: n.isp_code,
      area: 'oversea' as const,
      region: toRegion('oversea'),
    })),
  ];

  nodeCache.upsertAll(metas, updatedAt);
  return nodeCache.snapshot();
}

export function startNodeCacheAutoRefresh(): void {
  nodeCache.startAutoRefresh(refreshNodeCache, config.nodes.refreshIntervalHours);
}

