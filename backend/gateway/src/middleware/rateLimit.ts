/**
 * Guardrail 9 (ARCHITECTURE.md §5): per-instance token bucket keyed by the asserted user.
 * Capacity `burst`, refill `perMinute / 60` tokens per second, never above capacity.
 * No x-user-id means no bucket to key on — auth.ts owns the 401, the limiter defers.
 */
import type express from 'express';
import { USER_HEADER, type ErrorBody } from '@lumina/contract';

export interface RateLimitOptions {
  perMinute: number;
  burst: number;
  /** Injected millisecond clock — no Date.now() in the hot path, so tests stay deterministic. */
  now: () => number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export function makeRateLimit({ perMinute, burst, now }: RateLimitOptions): express.RequestHandler {
  const perSecond = perMinute / 60;
  const buckets = new Map<string, Bucket>();

  const refill = (userId: string, at: number): Bucket => {
    const bucket = buckets.get(userId) ?? { tokens: burst, updatedAt: at };
    const gained = ((at - bucket.updatedAt) / 1000) * perSecond;
    bucket.tokens = Math.min(burst, bucket.tokens + gained);
    bucket.updatedAt = at;
    buckets.set(userId, bucket);
    return bucket;
  };

  return (req, res, next) => {
    const userId = req.header(USER_HEADER);
    if (!userId) {
      next();
      return;
    }

    const bucket = refill(userId, now());
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      next();
      return;
    }

    // A throttled request costs nothing: the bucket only pays for admitted work.
    const waitSeconds = perSecond > 0 ? (1 - bucket.tokens) / perSecond : Number.POSITIVE_INFINITY;
    const body: ErrorBody = {
      error: `rate limit exceeded for ${userId}: ${perMinute}/min, burst ${burst}`,
      status: 429,
      ...(res.locals.requestId ? { requestId: String(res.locals.requestId) } : {})
    };
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(waitSeconds))));
    res.status(429).json(body);
  };
}
