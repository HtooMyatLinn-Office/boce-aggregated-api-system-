import request from 'supertest';
import app from '../app';

jest.mock('../services/queue/detectQueue', () => ({
  enqueueDetection: jest.fn().mockResolvedValue({ id: 'job-1' }),
  detectQueue: {
    getJob: jest.fn().mockResolvedValue({
      id: 'job-1',
      getState: jest.fn().mockResolvedValue('completed'),
      attemptsMade: 1,
      progress: 100,
      failedReason: null,
      returnvalue: { ok: true },
    }),
  },
}));

describe('detect async queue endpoints (Step 7)', () => {
  it('POST /api/detect with async returns 202 and jobId', async () => {
    const res = await request(app)
      .post('/api/detect?async=1')
      .send({ url: 'www.baidu.com' })
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(res.body.jobId).toBe('job-1');
    expect(res.body.statusUrl).toContain('/api/detect/jobs/job-1');
  });

  it('GET /api/detect/jobs/:jobId returns job state and result', async () => {
    const res = await request(app).get('/api/detect/jobs/job-1');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.state).toBe('completed');
    expect(res.body.result).toEqual({ ok: true });
  });
});

