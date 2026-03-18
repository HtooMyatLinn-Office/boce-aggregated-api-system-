import Redis from 'ioredis';
import { config } from '../../config';

let connection: Redis | undefined;

export function getRedis(): Redis {
  if (!connection) {
    connection = new Redis(config.redis.url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
  }
  return connection;
}

