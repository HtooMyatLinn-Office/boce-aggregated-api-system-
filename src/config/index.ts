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
    rateLimit: {
      enabled: (process.env.RATE_LIMIT_ENABLED ?? 'true') === 'true',
      windowSec: parseInt(process.env.RATE_LIMIT_WINDOW_SEC ?? '60', 10),
      maxRequests: parseInt(process.env.RATE_LIMIT_MAX ?? '30', 10),
    },
  },
  integrations: {
    // App-level default webhook (lowest priority; task-level webhook overrides this)
    webhookUrl: process.env.APP_WEBHOOK_URL ?? '',
  },
} as const;
