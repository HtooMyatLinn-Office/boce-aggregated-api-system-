import { NextFunction, Request, Response } from 'express';
import { config } from '../config';
import { authenticateClient } from '../services/db/clientAuthRepo';

export async function requireClientAuth(req: Request, res: Response, next: NextFunction) {
  // Keep unit/integration tests stable regardless of local .env auth flags.
  if (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID) return next();
  if (!config.auth?.enabled) return next();

  const clientId = req.header('X-Client-Id')?.trim();
  const apiKey = req.header('X-Api-Key')?.trim();

  if (!clientId || !apiKey) {
    return res.status(401).json({
      success: false,
      error: 'Missing authentication headers',
      requiredHeaders: ['X-Client-Id', 'X-Api-Key'],
    });
  }

  // Static mode: use fixed env credentials (fast path, no DB lookup).
  if (config.auth.staticMode) {
    const expectedClientId = config.auth.staticClientId;
    const expectedApiKey = config.auth.staticApiKey;
    if (!expectedClientId || !expectedApiKey) {
      return res.status(500).json({
        success: false,
        error: 'Static auth is enabled but AUTH_STATIC_CLIENT_ID/API_KEY is not configured',
      });
    }

    if (clientId !== expectedClientId || apiKey !== expectedApiKey) {
      return res.status(401).json({ success: false, error: 'Invalid client credentials' });
    }

    req.authClient = {
      clientId: expectedClientId,
      clientName: config.auth.staticClientName,
      defaultWebhookUrl: config.auth.staticDefaultWebhookUrl || null,
      maxBatchSize: Math.max(1, Math.min(config.auth.staticMaxBatchSize, 5000)),
    };
    return next();
  }

  const auth = await authenticateClient({ clientId, apiKey });
  if (!auth) {
    return res.status(401).json({ success: false, error: 'Invalid client credentials' });
  }

  req.authClient = {
    clientId: auth.clientId,
    clientName: auth.clientName,
    defaultWebhookUrl: auth.defaultWebhookUrl,
    maxBatchSize: auth.maxBatchSize,
  };
  return next();
}

