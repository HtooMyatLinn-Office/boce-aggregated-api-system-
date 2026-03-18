import request from 'supertest';
import app from '../app';

jest.mock('../services/db/detectionsRepo', () => ({
  saveDetection: jest.fn().mockResolvedValue(undefined),
  getDetectionByRequestId: jest.fn().mockResolvedValue({ requestId: 'r1', url: 'u', taskId: 't', timestamp: 'x', probes: [], availability: { regional: [], global: { total: 0, success: 0, availabilityRate: 0 } }, anomalies: [], summary: { overallStatus: 'HEALTHY', message: 'ok' } }),
  listDetectionsByUrl: jest.fn().mockResolvedValue([{ requestId: 'r1' }]),
}));

jest.mock('../services/detection/detect', () => ({
  detectOnce: jest.fn().mockResolvedValue({ requestId: 'r1', url: 'u', taskId: 't', timestamp: 'x', probes: [], availability: { regional: [], global: { total: 0, success: 0, availabilityRate: 0 } }, anomalies: [], summary: { overallStatus: 'HEALTHY', message: 'ok' } }),
}));

describe('storage endpoints (Step 8)', () => {
  it('GET /api/detect/results/:requestId returns stored result', async () => {
    const res = await request(app).get('/api/detect/results/r1');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.requestId).toBe('r1');
  });

  it('GET /api/detect/history requires url', async () => {
    const res = await request(app).get('/api/detect/history');
    expect(res.status).toBe(400);
  });

  it('GET /api/detect/history returns items', async () => {
    const res = await request(app).get('/api/detect/history?url=www.baidu.com&limit=5');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.count).toBe(1);
  });
});

