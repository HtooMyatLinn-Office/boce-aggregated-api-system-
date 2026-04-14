import dotenv from 'dotenv';

dotenv.config();

/**
 * Hostnames allowed in HTTP `Host` for MCP Stream HTTP (MCP SDK DNS-rebinding middleware).
 * When unset, SDK defaults to localhost-only validation — public domains must be listed here.
 * Comma-separated in env, e.g. MCP_ALLOWED_HOSTS=boce-center.example.com
 */
export function getMcpAllowedHostsForExpress(): string[] | undefined {
  const raw = process.env.MCP_ALLOWED_HOSTS?.trim();
  if (!raw) return undefined;
  const fromEnv = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (fromEnv.length === 0) return undefined;
  const local = ['localhost', '127.0.0.1', '[::1]'];
  return [...new Set([...local, ...fromEnv])];
}

export const config = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  nodeEnv: process.env.NODE_ENV ?? 'development',

  boce: {
    baseUrl: process.env.BOCE_BASE_URL ?? 'https://api.boce.com',
    apiKey: process.env.BOCE_API_KEY ?? '',
  },

  redis: {
    url: process.env.REDIS_URL ?? 'redis://localhost:6379',
  },

  detection: {
    pollIntervalMs: 10_000,
    pollTimeoutMs: 120_000,
  },

  nodes: {
    refreshIntervalHours: parseInt(process.env.BOCE_NODE_REFRESH_HOURS ?? '6', 10),
  },

  queue: {
    enabled: (process.env.QUEUE_ENABLED ?? 'true') === 'true',
    concurrency: parseInt(process.env.QUEUE_CONCURRENCY ?? '5', 10),
    jobTimeoutMs: parseInt(process.env.QUEUE_JOB_TIMEOUT_MS ?? '150000', 10), // 2min30s
    dispatchIntervalMs: parseInt(process.env.QUEUE_DISPATCH_INTERVAL_MS ?? '1500', 10),
    dispatchBatchSize: parseInt(process.env.QUEUE_DISPATCH_BATCH_SIZE ?? '200', 10),
    rateLimit: {
      enabled: (process.env.RATE_LIMIT_ENABLED ?? 'true') === 'true',
      windowSec: parseInt(process.env.RATE_LIMIT_WINDOW_SEC ?? '60', 10),
      maxRequests: parseInt(process.env.RATE_LIMIT_MAX ?? '30', 10),
    },
  },
  integrations: {
    // App-level default webhook (lowest priority; task-level webhook overrides this)
    webhookUrl: process.env.APP_WEBHOOK_URL ?? '',
    webhookSigningSecret: process.env.WEBHOOK_SIGNING_SECRET ?? '',
  },
  auth: {
    enabled: (process.env.AUTH_ENABLED ?? 'false') === 'true',
    // Static mode: validate against fixed env client/key (no DB lookup)
    staticMode: (process.env.AUTH_STATIC_MODE ?? 'false') === 'true',
    staticClientId: process.env.AUTH_STATIC_CLIENT_ID ?? '',
    staticApiKey: process.env.AUTH_STATIC_API_KEY ?? '',
    staticClientName: process.env.AUTH_STATIC_CLIENT_NAME ?? 'Static Client',
    staticMaxBatchSize: parseInt(process.env.AUTH_STATIC_MAX_BATCH_SIZE ?? '5000', 10),
    staticDefaultWebhookUrl: process.env.AUTH_STATIC_DEFAULT_WEBHOOK_URL ?? '',
    bootstrapClientId: process.env.BOOTSTRAP_CLIENT_ID ?? '',
    bootstrapClientName: process.env.BOOTSTRAP_CLIENT_NAME ?? 'Default App',
    bootstrapApiKey: process.env.BOOTSTRAP_API_KEY ?? '',
  },
  admin: {
    token: process.env.ADMIN_TOKEN ?? '',
  },
  mcp: {
    authEnabled: (process.env.MCP_AUTH_ENABLED ?? 'false') === 'true',
    authToken: process.env.MCP_AUTH_TOKEN ?? '',
    authAllowQueryToken: (process.env.MCP_AUTH_ALLOW_QUERY_TOKEN ?? 'false') === 'true',
  },

  /** HLS stream probe: external playback catalog + m3u8 fetch limits */
  stream: {
    playbackApiUrl: process.env.STREAM_PLAYBACK_API_URL ?? '',
    /** Optional HTTP method for playback API (GET or POST) */
    playbackApiMethod: (process.env.STREAM_PLAYBACK_API_METHOD ?? 'GET').toUpperCase() as 'GET' | 'POST',
    m3u8FetchTimeoutMs: parseInt(process.env.STREAM_M3U8_FETCH_TIMEOUT_MS ?? '15000', 10),
    sourceConcurrency: Math.max(1, Math.min(3, parseInt(process.env.STREAM_SOURCE_CONCURRENCY ?? '2', 10))),
    sourceBatchDelayMinMs: parseInt(process.env.STREAM_SOURCE_BATCH_DELAY_MIN_MS ?? '300', 10),
    sourceBatchDelayMaxMs: parseInt(process.env.STREAM_SOURCE_BATCH_DELAY_MAX_MS ?? '500', 10),
    probeDelayMinMs: parseInt(process.env.STREAM_PROBE_DELAY_MIN_MS ?? '1000', 10),
    probeDelayMaxMs: parseInt(process.env.STREAM_PROBE_DELAY_MAX_MS ?? '2000', 10),
    cacheTtlMinSec: parseInt(process.env.STREAM_CACHE_TTL_MIN_SEC ?? '600', 10),
    cacheTtlMaxSec: parseInt(process.env.STREAM_CACHE_TTL_MAX_SEC ?? '1800', 10),
    maxNodes: Math.min(3, parseInt(process.env.STREAM_MAX_NODES ?? '3', 10)),
  },
} as const;
