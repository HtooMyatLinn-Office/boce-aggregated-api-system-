import { Anomaly, NormalizedProbe } from '../../types';

function is2xx(code?: number): boolean {
  return typeof code === 'number' && code >= 200 && code < 300;
}

export function detectAnomalies(
  probes: NormalizedProbe[],
  ipWhitelist?: string[]
): Anomaly[] {
  const whitelist = (ipWhitelist ?? []).map((s) => s.trim()).filter(Boolean);
  const useWhitelist = whitelist.length > 0;

  const anomalies: Anomaly[] = [];

  for (const p of probes) {
    // Boce node-level error
    if (typeof p.boceErrorCode === 'number' && p.boceErrorCode !== 0) {
      anomalies.push({
        region: p.region,
        nodeId: p.nodeId,
        ip: p.responseIp,
        statusCode: p.statusCode,
        reason: 'BOCE_ERROR',
        message: p.boceError ?? `boce error_code=${p.boceErrorCode}`,
      });
    }

    // Non-2xx HTTP status
    if (typeof p.statusCode === 'number' && !is2xx(p.statusCode)) {
      anomalies.push({
        region: p.region,
        nodeId: p.nodeId,
        ip: p.responseIp,
        statusCode: p.statusCode,
        reason: 'NON_2XX_STATUS',
        message: `HTTP ${p.statusCode}`,
      });
    }

    // IP whitelist mismatch
    if (useWhitelist && p.responseIp && !whitelist.includes(p.responseIp)) {
      anomalies.push({
        region: p.region,
        nodeId: p.nodeId,
        ip: p.responseIp,
        statusCode: p.statusCode,
        reason: 'IP_NOT_IN_WHITELIST',
        message: `IP ${p.responseIp} not in whitelist`,
      });
    }
  }

  return anomalies;
}

