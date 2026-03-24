import crypto from 'crypto';
import { getDbPool } from './pool';

export interface ClientAuthContext {
  clientId: string;
  clientName: string;
  defaultWebhookUrl?: string | null;
  maxBatchSize: number;
  isActive: boolean;
}

function hashKey(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

export async function bootstrapClient(params: {
  clientId: string;
  clientName: string;
  apiKey: string;
}): Promise<void> {
  const pool = getDbPool();
  const keyHash = hashKey(params.apiKey);
  await pool.query(
    `INSERT INTO client_apps (id, name, is_active)
     VALUES ($1, $2, true)
     ON CONFLICT (id) DO NOTHING`,
    [params.clientId, params.clientName]
  );
  await pool.query(
    `INSERT INTO api_keys (client_id, key_hash, name, is_active)
     VALUES ($1, $2, 'bootstrap', true)
     ON CONFLICT (key_hash) DO NOTHING`,
    [params.clientId, keyHash]
  );
}

export async function authenticateClient(params: {
  clientId: string;
  apiKey: string;
}): Promise<ClientAuthContext | null> {
  const pool = getDbPool();
  const keyHash = hashKey(params.apiKey);
  const res = await pool.query(
    `SELECT
       c.id AS client_id,
       c.name AS client_name,
       c.default_webhook_url,
       c.max_batch_size,
       c.is_active
     FROM client_apps c
     JOIN api_keys k ON k.client_id = c.id
     WHERE c.id = $1
       AND c.is_active = true
       AND k.is_active = true
       AND (k.expires_at IS NULL OR k.expires_at > now())
       AND k.key_hash = $2
     LIMIT 1`,
    [params.clientId, keyHash]
  );
  if ((res.rowCount ?? 0) === 0) return null;

  const row = res.rows[0];
  return {
    clientId: row.client_id,
    clientName: row.client_name,
    defaultWebhookUrl: row.default_webhook_url,
    maxBatchSize: Number(row.max_batch_size ?? 5000),
    isActive: Boolean(row.is_active),
  };
}

export async function createClientApp(params: {
  clientId: string;
  name: string;
  defaultWebhookUrl?: string;
  maxBatchSize?: number;
}): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `INSERT INTO client_apps (id, name, default_webhook_url, max_batch_size, is_active)
     VALUES ($1, $2, $3, $4, true)
     ON CONFLICT (id) DO UPDATE
       SET name=EXCLUDED.name,
           default_webhook_url=EXCLUDED.default_webhook_url,
           max_batch_size=EXCLUDED.max_batch_size,
           updated_at=now()`,
    [
      params.clientId,
      params.name,
      params.defaultWebhookUrl ?? null,
      Math.max(1, Math.min(params.maxBatchSize ?? 5000, 5000)),
    ]
  );
}

export async function createClientApiKey(params: {
  clientId: string;
  name?: string;
  expiresAt?: string;
}): Promise<{ keyId: number; apiKey: string }> {
  const pool = getDbPool();
  const apiKey = `bk_${crypto.randomBytes(24).toString('hex')}`;
  const keyHash = hashKey(apiKey);
  const res = await pool.query(
    `INSERT INTO api_keys (client_id, key_hash, name, is_active, expires_at)
     VALUES ($1, $2, $3, true, $4)
     RETURNING id`,
    [params.clientId, keyHash, params.name ?? 'generated', params.expiresAt ?? null]
  );
  return { keyId: Number(res.rows[0].id), apiKey };
}

export async function revokeClientApiKey(params: { keyId: number }): Promise<boolean> {
  const pool = getDbPool();
  const res = await pool.query(
    `UPDATE api_keys
     SET is_active=false
     WHERE id=$1 AND is_active=true
     RETURNING id`,
    [params.keyId]
  );
  return (res.rowCount ?? 0) > 0;
}

