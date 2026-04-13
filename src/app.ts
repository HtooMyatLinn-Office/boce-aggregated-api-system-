import express from 'express';
import cors from 'cors';
import 'express-async-errors';
import { healthRouter } from './routes/health';
import { mountDevRoutes } from './routes/dev';
import { detectRouter } from './routes/detect';
import { batchDetectRouter } from './routes/batch-detect';
import { rateLimit } from './middleware/rateLimit';
import { requireClientAuth } from './middleware/clientAuth';
import { analyticsRouter } from './routes/analytics';
import { adminRouter } from './routes/admin';
import { requireAdminToken } from './middleware/adminAuth';
import { streamRouter } from './routes/stream';

const app = express();

app.use(cors());
app.use(express.json());

app.use('/health', healthRouter);
mountDevRoutes(app);
app.use('/api/detect', rateLimit, requireClientAuth, detectRouter);
app.use('/api/batch-detect', rateLimit, requireClientAuth, batchDetectRouter);
app.use('/api/analytics', rateLimit, requireClientAuth, analyticsRouter);
app.use('/api/stream', rateLimit, requireClientAuth, streamRouter);
app.use('/api/admin', requireAdminToken, adminRouter);

// Placeholder for future unified detect API
app.get('/', (_req, res) => {
  res.json({
    name: 'Boce Aggregated API System',
    version: '0.1.0',
    docs: { health: '/health', detect: 'POST /api/detect' },
  });
});

// 404
app.use((_req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'Internal Server Error', message: err.message });
});

export default app;
