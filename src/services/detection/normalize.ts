import { BoceResultListItem } from '../boce';
import { nodeCache } from '../boce';
import { NormalizedProbe, RegionGroup } from '../../types';

function regionFromNodeId(nodeId: number): RegionGroup {
  const meta = nodeCache.getNode(nodeId);
  if (!meta) return 'Unknown';
  // our node cache uses CN vs Global
  if (meta.region === 'CN') return 'CN';
  if (meta.region === 'Global') return 'Global';
  return 'Unknown';
}

export function normalizeProbe(item: BoceResultListItem): NormalizedProbe {
  const nodeId = item.node_id;
  const meta = nodeCache.getNode(nodeId);
  const latencyMs =
    typeof item.time_total === 'number' ? Math.round(item.time_total * 1000) : undefined;

  return {
    nodeId,
    nodeName: meta?.nodeName ?? item.node_name,
    ispName: meta?.ispName ?? item.ip_isp,
    region: regionFromNodeId(nodeId),
    statusCode: item.http_code,
    responseIp: item.remote_ip,
    latencyMs,
    boceErrorCode: item.error_code,
    boceError: item.error,
  };
}

export function normalizeProbes(list: BoceResultListItem[]): NormalizedProbe[] {
  return list.map(normalizeProbe);
}

