import dotenv from 'dotenv';

dotenv.config();

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
} as const;
