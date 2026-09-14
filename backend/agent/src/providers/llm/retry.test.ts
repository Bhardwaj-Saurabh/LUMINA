import { describe, expect, it, vi } from 'vitest';
import { decideRetry, withRetry, type RetryPolicy } from './retry.js';

/**
 * LLM retry policy — why this module exists at all.
 *
 * The openai SDK retries twice by default and honours Azure's `Retry-After`, which on a
 * throttled deployment is 30 seconds. The sleep happens INSIDE `client.chat.completions.create`
 * and is not abortable, so neither the request budget nor the tool deadline can see or stop it.
 * Deployed, that produced two 32-second "LLM turns" in one answer: TTFT 66 s against a 2.5 s
 * target, with nothing in the run log to explain it (agent log 2026-09-14T10:02:06Z).
 *
 * So the SDK's retries are turned off and the policy moves here, where it is bounded by a cap
 * we choose against the SLA, abortable by the request's signal, and reported to the caller so a
 * throttled turn appears in the evidence instead of looking like a slow model.
 */

const policy: RetryPolicy = { maxAttempts: 3, maxWaitMs: 4000 };

/** Shaped like an openai SDK APIError: `status` plus lowercased `headers`. */
const apiError = (status: number, headers: Record<string, string> = {}): Error =>
  Object.assign(new Error(`azure said ${status}`), { status, headers });

describe('decideRetry', () => {
  it('retries a 429 and waits what Retry-After asks, when that fits the cap', () => {
    const d = decideRetry(apiError(429, { 'retry-after': '2' }), 1, policy);

    expect(d.retry).toBe(true);
    expect(d.waitMs).toBe(2000);
  });

  it('caps a Retry-After far beyond the cap instead of sleeping for it', () => {
    // The case that cost 30 s per turn in the deploy: Azure asks for 30, the SLA allows 4.
    const d = decideRetry(apiError(429, { 'retry-after': '30' }), 1, policy);

    expect(d.retry).toBe(true);
    expect(d.waitMs).toBe(policy.maxWaitMs);
  });

  it('backs off exponentially when the provider names no Retry-After', () => {
    const first = decideRetry(apiError(503), 1, policy);
    const second = decideRetry(apiError(503), 2, policy);

    expect(first.retry).toBe(true);
    expect(second.waitMs).toBeGreaterThan(first.waitMs);
    expect(second.waitMs).toBeLessThanOrEqual(policy.maxWaitMs);
  });

  it('retries a connection error that never reached a status', () => {
    expect(decideRetry(new Error('ECONNRESET'), 1, policy).retry).toBe(true);
  });

  it('does not retry a request the provider rejected on its merits', () => {
    // 400/401/404 are our bug or our config; retrying only burns the latency budget.
    for (const status of [400, 401, 403, 404, 422]) {
      expect(decideRetry(apiError(status), 1, policy).retry).toBe(false);
    }
  });

  it('stops at the attempt ceiling even for a retryable status', () => {
    expect(decideRetry(apiError(429), policy.maxAttempts, policy).retry).toBe(false);
  });

  it('never retries a request the caller aborted', () => {
    const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' });

    expect(decideRetry(aborted, 1, policy).retry).toBe(false);
  });
});

describe('withRetry', () => {
  it('returns the first success without waiting', async () => {
    const fn = vi.fn().mockResolvedValue('ok');

    await expect(withRetry(fn, { policy })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a throttled call and reports the wait to the caller', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(apiError(429, { 'retry-after': '30' }))
      .mockResolvedValue('ok');
    const onRetry = vi.fn();
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(withRetry(fn, { policy, onRetry, sleep })).resolves.toBe('ok');

    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(policy.maxWaitMs, undefined);
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1, status: 429, waitMs: policy.maxWaitMs })
    );
  });

  it('rethrows the provider error once the attempts are spent — never a plausible substitute', async () => {
    const err = apiError(429);
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withRetry(fn, { policy, sleep: async () => undefined })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(policy.maxAttempts);
  });

  it('gives up immediately on an error the policy will not retry', async () => {
    const fn = vi.fn().mockRejectedValue(apiError(400));

    await expect(withRetry(fn, { policy })).rejects.toThrow('azure said 400');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('abandons the wait when the request is aborted mid-backoff', async () => {
    // The whole point: unlike the SDK's sleep, this one is cancellable, so a cap hit or a
    // client disconnect ends the turn instead of waiting out the provider's backoff.
    const controller = new AbortController();
    const fn = vi.fn().mockRejectedValue(apiError(429, { 'retry-after': '30' }));
    const sleep = vi.fn().mockImplementation(async () => {
      controller.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });

    await expect(
      withRetry(fn, { policy, signal: controller.signal, sleep })
    ).rejects.toThrow(/abort/i);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
