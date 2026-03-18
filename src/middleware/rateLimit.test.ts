import request from 'supertest';
import app from '../app';

jest.mock('../services/queue/redis', () => {
  let count = 0;
  return {
    getRedis: () => ({
      incr: async () => {
        count += 1;
        return count;
      },
      expire: async () => 1,
    }),
  };
});

jest.mock('../config', () => ({
  config: {
    queue: {
      rateLimit: { enabled: true, windowSec: 60, maxRequests: 2 },
    },
  },
}));

// Also mock /api/detect handler dependencies so we don't call Boce.
jest.mock('../services/detection/detect', () => ({
  detectOnce: jest.fn().mockResolvedValue({ requestId: 'x' }),
}));

describe('rate limit middleware (Step 7)', () => {
  it('returns 429 after exceeding limit', async () => {
    const body = { url: 'www.baidu.com' };
    const r1 = await request(app).post('/api/detect').send(body);
    const r2 = await request(app).post('/api/detect').send(body);
    const r3 = await request(app).post('/api/detect').send(body);

    expect(r1.status).not.toBe(429);
    expect(r2.status).not.toBe(429);
    expect(r3.status).toBe(429);
  });
});

