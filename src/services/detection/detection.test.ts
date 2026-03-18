import { computeAvailability } from './metrics';
import { detectAnomalies } from './anomalies';
import { NormalizedProbe } from '../../types';

describe('detection services (Steps 7-8)', () => {
  it('computeAvailability calculates regional and global rates', () => {
    const probes: NormalizedProbe[] = [
      { nodeId: 1, region: 'CN', statusCode: 200 },
      { nodeId: 2, region: 'CN', statusCode: 500 },
      { nodeId: 3, region: 'Global', statusCode: 204 },
    ];

    const m = computeAvailability(probes);
    expect(m.global.total).toBe(3);
    expect(m.global.success).toBe(2);
    expect(m.global.availabilityRate).toBeCloseTo(2 / 3);
    const cn = m.regional.find((r) => r.region === 'CN')!;
    expect(cn.total).toBe(2);
    expect(cn.success).toBe(1);
  });

  it('detectAnomalies finds non-2xx and whitelist mismatches', () => {
    const probes: NormalizedProbe[] = [
      { nodeId: 1, region: 'CN', statusCode: 302, responseIp: '1.1.1.1' },
      { nodeId: 2, region: 'CN', statusCode: 200, responseIp: '2.2.2.2' },
      { nodeId: 3, region: 'Global', statusCode: 200, responseIp: '3.3.3.3', boceErrorCode: 123, boceError: 'x' },
    ];

    const a = detectAnomalies(probes, ['2.2.2.2']);
    expect(a.some((x) => x.reason === 'NON_2XX_STATUS')).toBe(true);
    expect(a.some((x) => x.reason === 'IP_NOT_IN_WHITELIST' && x.ip === '1.1.1.1')).toBe(true);
    expect(a.some((x) => x.reason === 'BOCE_ERROR')).toBe(true);
  });
});

