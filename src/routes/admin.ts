import { Router } from 'express';
import { createClientApiKey, createClientApp, revokeClientApiKey } from '../services/db/clientAuthRepo';

export const adminRouter = Router();

adminRouter.post('/clients', async (req, res) => {
  const body = req.body as {
    clientId?: string;
    name?: string;
    defaultWebhookUrl?: string;
    maxBatchSize?: number;
  };
  const clientId = body.clientId?.trim();
  const name = body.name?.trim();
  if (!clientId || !name) {
    return res.status(400).json({ success: false, error: 'clientId and name are required' });
  }
  await createClientApp({
    clientId,
    name,
    defaultWebhookUrl: body.defaultWebhookUrl,
    maxBatchSize: body.maxBatchSize,
  });
  return res.json({ success: true, clientId });
});

adminRouter.post('/clients/:clientId/keys', async (req, res) => {
  const clientId = req.params.clientId;
  const body = req.body as { name?: string; expiresAt?: string };
  const created = await createClientApiKey({
    clientId,
    name: body.name,
    expiresAt: body.expiresAt,
  });
  return res.json({
    success: true,
    clientId,
    keyId: created.keyId,
    apiKey: created.apiKey, // returned once
  });
});

adminRouter.post('/keys/:keyId/revoke', async (req, res) => {
  const keyId = Number(req.params.keyId);
  if (!Number.isFinite(keyId)) return res.status(400).json({ success: false, error: 'invalid keyId' });
  const ok = await revokeClientApiKey({ keyId });
  if (!ok) return res.status(404).json({ success: false, error: 'key not found or already revoked' });
  return res.json({ success: true, keyId });
});

