import { Router } from 'express';
import { getMonthlyClientAnalytics } from '../services/db/detectionsRepo';

export const analyticsRouter = Router();

analyticsRouter.get('/clients/:clientId/monthly', async (req, res) => {
  const clientId = req.params.clientId;
  const month = typeof req.query.month === 'string' ? req.query.month : '';
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ success: false, error: 'month must be YYYY-MM' });
  }

  const authClientId = req.authClient?.clientId;
  if (authClientId && authClientId !== clientId) {
    return res.status(403).json({ success: false, error: 'forbidden for this clientId' });
  }

  const data = await getMonthlyClientAnalytics({ clientId, month });
  return res.json({ success: true, clientId, ...data });
});

