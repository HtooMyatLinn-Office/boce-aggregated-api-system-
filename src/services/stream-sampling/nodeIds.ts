import { NodeMeta, nodeCache, refreshNodeCache } from '../boce';

/** Region aliases for matching Boce node_name (Chinese / English / short). */
const REGION_ALIASES: Record<string, string[]> = {
  guangdong: ['guangdong', '广东', 'gd'],
  guangzhou: ['guangzhou', '广州'],
  beijing: ['beijing', '北京'],
  shanghai: ['shanghai', '上海'],
};

function expandRegionTokens(region: string): string[] {
  const key = region.trim().toLowerCase();
  const base = [key];
  const extra = REGION_ALIASES[key] ?? [];
  return [...new Set([...base, ...extra.map((x) => x.toLowerCase())])];
}

function nodeMatchesRegion(node: NodeMeta, region: string): boolean {
  if (!region.trim()) return true;
  const tokens = expandRegionTokens(region);
  const name = node.nodeName.toLowerCase();
  return tokens.some((t) => name.includes(t));
}

function ispBucket(ispName: string): 'mobile' | 'unicom' | 'telecom' | 'other' {
  if (ispName.includes('移动')) return 'mobile';
  if (ispName.includes('联通')) return 'unicom';
  if (ispName.includes('电信')) return 'telecom';
  return 'other';
}

/**
 * Pick up to `maxNodes` Boce node ids in a region, preferring one mobile / unicom / telecom when available.
 */
export async function selectStreamProbeNodeIds(region: string, maxNodes: number): Promise<string> {
  if (nodeCache.snapshot().total === 0) {
    await refreshNodeCache();
  }

  const candidates = nodeCache
    .listNodes()
    .filter((n) => n.area === 'mainland' && nodeMatchesRegion(n, region))
    .sort((a, b) => a.id - b.id);

  const buckets: ('mobile' | 'unicom' | 'telecom')[] = ['mobile', 'unicom', 'telecom'];
  const picked: NodeMeta[] = [];
  const used = new Set<number>();

  for (const b of buckets) {
    if (picked.length >= maxNodes) break;
    const hit = candidates.find((n) => !used.has(n.id) && ispBucket(n.ispName) === b);
    if (hit) {
      picked.push(hit);
      used.add(hit.id);
    }
  }

  for (const n of candidates) {
    if (picked.length >= maxNodes) break;
    if (!used.has(n.id)) {
      picked.push(n);
      used.add(n.id);
    }
  }

  return picked
    .slice(0, maxNodes)
    .map((n) => n.id)
    .join(',');
}

/** Fallback nodeIds when region-specific matching yields no usable candidates. */
export function getFallbackStreamProbeNodeIds(maxNodes: number): string {
  const raw = process.env.BOCE_DEFAULT_NODE_IDS?.trim() || '31,32,33';
  const ids = raw
    .split(',')
    .map((x) => x.trim())
    .filter((x) => /^\d+$/.test(x));
  return ids.slice(0, Math.max(1, maxNodes)).join(',');
}
