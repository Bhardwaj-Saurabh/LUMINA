import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ErrorBody, USER_HEADER } from '@lumina/contract';
import { makeRateLimit } from './rateLimit.js';

/**
 * Guardrail 9 (ARCHITECTURE.md §5): per-instance token bucket keyed by the asserted user,
 * burst 10, refill RATE_LIMIT_PER_MINUTE/60 per second, 429 + Retry-After.
 *
 * Testing style: the middleware is exercised through a one-route express app with supertest
 * rather than a hand-rolled req/res double, because two of the behaviors under test are HTTP
 * facts (the status code and the Retry-After header) and supertest is the taxonomy's tool for
 * middleware. Determinism comes from the injected `now` clock — no timers, no Date.now().
 */

/** Injected millisecond clock; every test drives it explicitly. */
const fakeClock = (start = 1_700_000_000_000) => {
  let ms = start;
  return {
    now: () => ms,
    advanceSeconds: (s: number) => {
      ms += s * 1000;
    }
  };
};

type AppOptions = {
  perMinute: number;
  burst: number;
  now: () => number;
  cost?: (req: express.Request) => number;
};

/** One route behind the limiter; 200 means the middleware called next(). */
const appWith = (opts: AppOptions) => {
  const app = express();
  app.disable('x-powered-by');
  app.use(makeRateLimit(opts));
  app.get('/probe', (_req, res) => res.status(200).json({ admitted: true }));
  app.post('/threads/t1/ask', (_req, res) => res.status(200).json({ admitted: true }));
  return app;
};

describe('gateway rate limit middleware', () => {
  it('admits a request under the burst limit by calling next()', async () => {
    const clock = fakeClock();
    const app = appWith({ perMinute: 60, burst: 3, now: clock.now });

    const res = await request(app).get('/probe').set(USER_HEADER, 'u_alice');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ admitted: true });
    expect(res.headers['retry-after']).toBeUndefined();
  });

  it('admits exactly `burst` requests before the bucket is empty', async () => {
    const clock = fakeClock();
    const app = appWith({ perMinute: 60, burst: 3, now: clock.now });

    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await request(app).get('/probe').set(USER_HEADER, 'u_alice');
      statuses.push(res.status);
    }

    expect(statuses).toEqual([200, 200, 200]);
  });

  it('answers 429 with a contract-valid ErrorBody and a Retry-After header once the bucket is exhausted', async () => {
    const clock = fakeClock();
    const app = appWith({ perMinute: 60, burst: 2, now: clock.now });

    await request(app).get('/probe').set(USER_HEADER, 'u_alice');
    await request(app).get('/probe').set(USER_HEADER, 'u_alice');
    const res = await request(app).get('/probe').set(USER_HEADER, 'u_alice');

    expect(res.status).toBe(429);
    const body = ErrorBody.parse(res.body);
    expect(body.status).toBe(429);
    expect(body.error).toMatch(/rate limit/i);
    expect(res.headers['retry-after']).toBeDefined();
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });

  it('keeps one bucket per x-user-id: user A exhausting its bucket does not throttle user B', async () => {
    const clock = fakeClock();
    const app = appWith({ perMinute: 60, burst: 1, now: clock.now });

    const first = await request(app).get('/probe').set(USER_HEADER, 'u_alice');
    const second = await request(app).get('/probe').set(USER_HEADER, 'u_alice');
    const other = await request(app).get('/probe').set(USER_HEADER, 'u_bob');

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(other.status).toBe(200);
  });

  it('refills over time: after the injected clock advances 60s an exhausted user is admitted again', async () => {
    const clock = fakeClock();
    const app = appWith({ perMinute: 60, burst: 2, now: clock.now });

    await request(app).get('/probe').set(USER_HEADER, 'u_alice');
    await request(app).get('/probe').set(USER_HEADER, 'u_alice');
    const throttled = await request(app).get('/probe').set(USER_HEADER, 'u_alice');
    expect(throttled.status).toBe(429);

    clock.advanceSeconds(60);
    const afterRefill = await request(app).get('/probe').set(USER_HEADER, 'u_alice');

    expect(afterRefill.status).toBe(200);
  });

  it('never refills past the burst ceiling, so a long-idle user still only gets `burst` in a row', async () => {
    const clock = fakeClock();
    const app = appWith({ perMinute: 60, burst: 2, now: clock.now });

    clock.advanceSeconds(3600);

    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await request(app).get('/probe').set(USER_HEADER, 'u_alice');
      statuses.push(res.status);
    }

    expect(statuses).toEqual([200, 200, 429]);
  });

  it('charges an expensive route more of the bucket than a cheap one', async () => {
    // A status poll and a streamed LLM answer are not the same request. Priced at 1 each,
    // either the answer path is unprotected or polling is throttled to uselessness — the
    // shape that had the benchmark's own document polling collecting 429s.
    const clock = fakeClock();
    const app = appWith({
      perMinute: 60,
      burst: 10,
      now: clock.now,
      cost: (req) => (req.method === 'POST' && req.path.endsWith('/ask') ? 5 : 1)
    });

    // Two asks cost 10 of the 10-token bucket.
    for (let i = 0; i < 2; i++) {
      const res = await request(app).post('/threads/t1/ask').set(USER_HEADER, 'u_costly');
      expect(res.status).toBe(200);
    }
    const third = await request(app).post('/threads/t1/ask').set(USER_HEADER, 'u_costly');
    expect(third.status).toBe(429);

    // The cheap route is priced at 1, so the same bucket admits ten of those.
    const cheap = fakeClock();
    const cheapApp = appWith({
      perMinute: 60,
      burst: 10,
      now: cheap.now,
      cost: (req) => (req.method === 'POST' && req.path.endsWith('/ask') ? 5 : 1)
    });
    for (let i = 0; i < 10; i++) {
      const res = await request(cheapApp).get('/probe').set(USER_HEADER, 'u_cheap');
      expect(res.status).toBe(200);
    }
    const eleventh = await request(cheapApp).get('/probe').set(USER_HEADER, 'u_cheap');
    expect(eleventh.status).toBe(429);
  });

  it('prices every request at 1 when no cost function is injected', async () => {
    const clock = fakeClock();
    const app = appWith({ perMinute: 60, burst: 2, now: clock.now });

    for (let i = 0; i < 2; i++) {
      expect((await request(app).post('/threads/t1/ask').set(USER_HEADER, 'u_flat')).status).toBe(200);
    }
    expect((await request(app).post('/threads/t1/ask').set(USER_HEADER, 'u_flat')).status).toBe(429);
  });

  it('tells a throttled expensive request how long to wait for its FULL cost, not for one token', async () => {
    // Retry-After that only covers one token sends the client back to another 429.
    const clock = fakeClock();
    const app = appWith({ perMinute: 60, burst: 5, now: clock.now, cost: () => 5 });

    expect((await request(app).get('/probe').set(USER_HEADER, 'u_wait')).status).toBe(200);
    const throttled = await request(app).get('/probe').set(USER_HEADER, 'u_wait');

    expect(throttled.status).toBe(429);
    // Empty bucket, cost 5, refill 1/s ⇒ 5s, not 1s.
    expect(Number(throttled.headers['retry-after'])).toBe(5);
  });

  it('defers to the auth middleware when x-user-id is absent: it calls next() instead of throwing', async () => {
    const clock = fakeClock();
    const app = appWith({ perMinute: 60, burst: 1, now: clock.now });

    const first = await request(app).get('/probe');
    const second = await request(app).get('/probe');

    // No asserted user means no bucket to key on; 401 is auth.ts's job, not the limiter's.
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });
});
