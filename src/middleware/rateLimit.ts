import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { getRedis } from '../services/queue/redis';

function clientKey(req: Request): string {
  // simple: use remote IP (can be replaced with API key/user id later)
  return (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || 'unknown';
}

export async function rateLimit(req: Request, res: Response, next: NextFunction) {
  if (!config.queue.rateLimit.enabled) return next();

  const key = `rl:${clientKey(req)}:${req.path}`;
  const windowSec = Math.max(1, config.queue.rateLimit.windowSec);
  const max = Math.max(1, config.queue.rateLimit.maxRequests);

  try {
    const redis = getRedis();
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, windowSec);
    }

    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - count)));
    res.setHeader('X-RateLimit-Window', String(windowSec));

    if (count > max) {
      res.status(429).json({ success: false, error: 'Rate limit exceeded' });
      return;
    }
    next();
  } catch (e) {
    // fail-open: if Redis is down, don't block traffic
    next();
  }
}

