import { v4 as uuidv4 } from 'uuid';
import { runCurlDetectionWithConfig } from '../boce';
import { refreshNodeCache, nodeCache } from '../boce';
import { DetectionRequest, DetectionResult } from '../../types';
import { normalizeProbes } from './normalize';
import { computeAvailability } from './metrics';
import { detectAnomalies } from './anomalies';

function makeSummary(result: DetectionResult): DetectionResult['summary'] {
  const rate = result.availability.global.availabilityRate;
  const anomalies = result.anomalies.length;

  if (rate === 1 && anomalies === 0) {
    return { overallStatus: 'HEALTHY', message: 'All probes successful.' };
  }
  if (rate === 0) {
    return { overallStatus: 'UNAVAILABLE', message: 'All probes failed or returned non-2xx.' };
  }
  return {
    overallStatus: 'DEGRADED',
    message: `Availability ${(rate * 100).toFixed(1)}% with ${anomalies} anomalies.`,
  };
}

export async function detectOnce(req: DetectionRequest): Promise<DetectionResult> {
  // Ensure node cache is populated (refresh is designed to run every N hours in background,
  // but this avoids "Unknown" region on first request)
  if (nodeCache.snapshot().total === 0) {
    await refreshNodeCache();
  }

  const nodeIds = req.nodeIds ?? process.env.BOCE_DEFAULT_NODE_IDS ?? '31,32';

  const run = await runCurlDetectionWithConfig({
    host: req.url,
    nodeIds,
  });

  const probes = normalizeProbes(run.result.list);
  const availability = computeAvailability(probes);
  const anomalies = detectAnomalies(probes, req.ipWhitelist);

  const result: DetectionResult = {
    requestId: uuidv4(),
    url: req.url,
    taskId: run.taskId,
    timestamp: new Date().toISOString(),
    probes,
    availability,
    anomalies,
    summary: { overallStatus: 'DEGRADED', message: '' }, // filled next
  };

  result.summary = makeSummary(result);
  return result;
}

