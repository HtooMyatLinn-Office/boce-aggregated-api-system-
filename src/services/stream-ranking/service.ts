import { NormalizedProbe } from '../../types';
import { buildRegionCarrierCode, toRegionCode } from './codeMapper';

export interface StreamRankingRow {
  code: string;
  latency: number;
  nodeId: number;
  nodeName?: string;
  ispName?: string;
  statusCode?: number;
}

export interface StreamRankingResult {
  region: string;
  best: string;
  ranking: StreamRankingRow[];
}

export interface SourceProbeGroup {
  sourceCode: string;
  probes: NormalizedProbe[];
}

export interface StreamSourceRanking {
  api_from_code: string;
  best: string;
  ranking: StreamRankingRow[];
}

export interface StreamSourceRankingResult {
  region: string;
  sources: StreamSourceRanking[];
}

export interface IspPivotNode {
  code: string;
  nodeName?: string;
  ranking: Record<string, string>;
}

export interface IspPivotResult {
  region: string;
  nodes: IspPivotNode[];
}

/**
 * Rank stream probes into region+carrier codes (e.g. BJ_CM, GD_CT).
 * Keep only HTTP 200 probes with latency; pick best latency per code.
 */
export function rank(regionName: string, results: NormalizedProbe[]): StreamRankingResult {
  const ok = results.filter((p) => p.statusCode === 200 && typeof p.latencyMs === 'number');
  const sorted = [...ok].sort((a, b) => (a.latencyMs ?? 0) - (b.latencyMs ?? 0));

  const byCode = new Map<string, NormalizedProbe>();
  for (const p of sorted) {
    const code = buildRegionCarrierCode(regionName, p.ispName ?? '');
    if (code === 'OTHER') continue;
    if (!byCode.has(code)) byCode.set(code, p);
  }

  const ranking: StreamRankingRow[] = Array.from(byCode.entries()).map(([code, p]) => ({
    code,
    latency: p.latencyMs ?? 0,
    nodeId: p.nodeId,
    nodeName: p.nodeName,
    ispName: p.ispName,
    statusCode: p.statusCode,
  }));
  ranking.sort((a, b) => a.latency - b.latency);

  return {
    region: toRegionCode(regionName),
    best: ranking[0]?.code ?? 'OTHER',
    ranking,
  };
}

/** Rank probes grouped by playback source code (`api_from_code`). */
export function rankBySource(
  regionName: string,
  groups: SourceProbeGroup[]
): StreamSourceRankingResult {
  const sources: StreamSourceRanking[] = groups.map((g) => {
    const ranked = rank(regionName, g.probes);
    return {
      api_from_code: g.sourceCode,
      best: ranked.best,
      ranking: ranked.ranking,
    };
  });

  return {
    region: toRegionCode(regionName),
    sources,
  };
}

/**
 * Pivot source-centric probe groups to ISP-centric ranking:
 * BJ_CM/BJ_CT/BJ_CU -> { sourceCode: latency } (sorted by latency asc),
 * plus a region-level aggregate code (BJ) with best latency per source.
 */
export function pivotRankingByIsp(regionName: string, groups: SourceProbeGroup[]): IspPivotResult {
  const regionCode = toRegionCode(regionName);
  const ispBuckets = new Map<string, Array<{ source: string; latency: number; nodeName?: string }>>();
  const regionRows: Array<{ source: string; latency: number }> = [];

  for (const g of groups) {
    for (const p of g.probes) {
      if (p.statusCode !== 200 || typeof p.latencyMs !== 'number') continue;
      const ispCode = buildRegionCarrierCode(regionName, p.ispName ?? '');
      if (ispCode !== 'OTHER') {
        const list = ispBuckets.get(ispCode) ?? [];
        list.push({ source: g.sourceCode, latency: p.latencyMs, nodeName: p.nodeName });
        ispBuckets.set(ispCode, list);
      }
      regionRows.push({ source: g.sourceCode, latency: p.latencyMs });
    }
  }

  const bucketOrder = [`${regionCode}_CM`, `${regionCode}_CT`, `${regionCode}_CU`];
  const nodes: IspPivotNode[] = [];

  for (const code of bucketOrder) {
    const rows = ispBuckets.get(code) ?? [];
    const bestBySource = new Map<string, { latency: number; nodeName?: string }>();
    for (const r of rows) {
      const prev = bestBySource.get(r.source);
      if (!prev || r.latency < prev.latency) {
        bestBySource.set(r.source, { latency: r.latency, nodeName: r.nodeName });
      }
    }
    const sorted = Array.from(bestBySource.entries()).sort((a, b) => a[1].latency - b[1].latency);
    const ranking = Object.fromEntries(sorted.map(([source, v]) => [source, `${v.latency}ms`]));
    const nodeName = sorted[0]?.[1]?.nodeName;
    nodes.push({ code, nodeName, ranking });
  }

  // Region-level best latency per source (across all carriers)
  const regionBestBySource = new Map<string, number>();
  for (const r of regionRows) {
    const prev = regionBestBySource.get(r.source);
    if (prev === undefined || r.latency < prev) regionBestBySource.set(r.source, r.latency);
  }
  const regionRanking = Object.fromEntries(
    Array.from(regionBestBySource.entries())
      .sort((a, b) => a[1] - b[1])
      .map(([source, latency]) => [source, `${latency}ms`])
  );
  nodes.push({ code: regionCode, ranking: regionRanking });

  return { region: regionCode, nodes };
}
