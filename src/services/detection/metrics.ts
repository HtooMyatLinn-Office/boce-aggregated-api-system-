import { AvailabilityMetrics, NormalizedProbe, RegionAvailability, RegionGroup } from '../../types';

function isSuccess(p: NormalizedProbe): boolean {
  const code = p.statusCode;
  if (typeof code !== 'number') return false;
  return code >= 200 && code < 300;
}

function rate(success: number, total: number): number {
  if (total <= 0) return 0;
  return success / total;
}

export function computeAvailability(probes: NormalizedProbe[]): AvailabilityMetrics {
  const regions: RegionGroup[] = ['CN', 'Global', 'Unknown'];

  const regional: RegionAvailability[] = regions
    .map((region) => {
      const inRegion = probes.filter((p) => p.region === region);
      const total = inRegion.length;
      const success = inRegion.filter(isSuccess).length;
      return { region, total, success, availabilityRate: rate(success, total) };
    })
    .filter((r) => r.total > 0);

  const total = probes.length;
  const success = probes.filter(isSuccess).length;

  return {
    regional,
    global: { total, success, availabilityRate: rate(success, total) },
  };
}

