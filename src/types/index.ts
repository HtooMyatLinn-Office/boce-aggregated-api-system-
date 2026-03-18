/**
 * Shared types for detection request/response.
 * Expand in Steps 3–9 as you add normalization, metrics, anomalies.
 */

export interface DetectionRequest {
  url: string;
  ipWhitelist?: string[];
  nodeIds?: string;
  async?: boolean;
}

export type RegionGroup = 'CN' | 'Global' | 'Unknown';

export interface NormalizedProbe {
  nodeId: number;
  nodeName?: string;
  ispName?: string;
  region: RegionGroup;
  statusCode?: number;
  responseIp?: string;
  latencyMs?: number;
  boceErrorCode?: number;
  boceError?: string;
}

export interface RegionAvailability {
  region: RegionGroup;
  total: number;
  success: number;
  availabilityRate: number; // 0..1
}

export interface AvailabilityMetrics {
  regional: RegionAvailability[];
  global: {
    total: number;
    success: number;
    availabilityRate: number; // 0..1
  };
}

export type AnomalyReason = 'IP_NOT_IN_WHITELIST' | 'NON_2XX_STATUS' | 'BOCE_ERROR';

export interface Anomaly {
  region: RegionGroup;
  nodeId: number;
  ip?: string;
  statusCode?: number;
  reason: AnomalyReason;
  message?: string;
}

export interface DetectionResult {
  requestId: string;
  url: string;
  taskId: string;
  timestamp: string;
  probes: NormalizedProbe[];
  availability: AvailabilityMetrics;
  anomalies: Anomaly[];
  summary: { overallStatus: 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE'; message: string };
}
