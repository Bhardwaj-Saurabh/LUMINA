/**
 * Bounded, observable retry for provider calls — ARCHITECTURE.md §5 (fail loud, bounded).
 *
 * The openai SDK's own retry is the wrong shape for this service: it sleeps for whatever
 * `Retry-After` the provider names (30 s on a throttled Azure deployment), it does that inside
 * `completions.create` where the request budget cannot see it, and its sleep ignores the abort
 * signal. Deployed, one throttled answer spent 32 s in turn 1 and 33 s in turn 2 — TTFT 66 s
 * against a 2500 ms target — and the run log showed only "a slow LLM turn".
 *
 * So `maxRetries: 0` on the client and the policy lives here:
 *   - bounded  — the wait is capped by `maxWaitMs`, chosen against the SLA, not by the provider;
 *   - abortable — the wait ends when the request's signal fires;
 *   - visible  — `onRetry` hands the caller the status and the wait, so a throttled turn is
 *                evidence in the log rather than an unexplained gap.
 *
 * A retry that runs out of attempts rethrows the provider's error untouched: a 502 with the
 * real reason beats a plausible answer (A1).
 */

export interface RetryPolicy {
  /** Total attempts, not extra ones: 1 disables retrying. */
  maxAttempts: number;
  /** Ceiling on a single backoff. The provider may ask for longer; we decline. */
  maxWaitMs: number;
}

export interface RetryDecision {
  retry: boolean;
  waitMs: number;
  /** Why — carried into the log line so a slow turn names its cause. */
  reason: string;
}

export interface RetryAttempt {
  attempt: number;
  waitMs: number;
  status?: number;
  reason: string;
}

export interface WithRetryOptions {
  policy: RetryPolicy;
  signal?: AbortSignal;
  onRetry?: (info: RetryAttempt) => void;
  /** Injected in tests so the backoff costs no wall-clock. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Base for the exponential backoff when the provider names no `Retry-After`. */
const BASE_BACKOFF_MS = 250;

/** Throttling, and the transient server-side failures worth one more attempt. */
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

const statusOf = (err: unknown): number | undefined => {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
};

const isAbort = (err: unknown): boolean =>
  (err as { name?: unknown } | null)?.name === 'AbortError' ||
  (err as { name?: unknown } | null)?.name === 'APIUserAbortError';

/** `Retry-After` is seconds (Azure) or an HTTP date (rare); both are read, neither is trusted. */
const retryAfterMs = (err: unknown): number | undefined => {
  const headers = (err as { headers?: unknown } | null)?.headers;
  const raw =
    headers instanceof Headers
      ? headers.get('retry-after')
      : typeof headers === 'object' && headers !== null
        ? ((headers as Record<string, string>)['retry-after'] ??
          (headers as Record<string, string>)['Retry-After'])
        : undefined;
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
};

export function decideRetry(err: unknown, attempt: number, policy: RetryPolicy): RetryDecision {
  // An abort is the caller's decision (cap hit, client gone) — retrying would fight it.
  if (isAbort(err)) return { retry: false, waitMs: 0, reason: 'aborted' };
  if (attempt >= policy.maxAttempts) {
    return { retry: false, waitMs: 0, reason: `attempts exhausted (${policy.maxAttempts})` };
  }

  const status = statusOf(err);
  // No status at all is a connection-level failure (ECONNRESET, socket hang up): retryable.
  if (status !== undefined && !RETRYABLE_STATUS.has(status)) {
    return { retry: false, waitMs: 0, reason: `status ${status} is not transient` };
  }

  const asked = retryAfterMs(err);
  const backoff = asked ?? BASE_BACKOFF_MS * 2 ** (attempt - 1);
  const waitMs = Math.min(backoff, policy.maxWaitMs);
  const capped = asked !== undefined && asked > policy.maxWaitMs;
  return {
    retry: true,
    waitMs,
    reason: capped
      ? `${status ?? 'connection error'}: provider asked ${Math.round(asked / 1000)}s, capped at ${policy.maxWaitMs}ms`
      : `${status ?? 'connection error'}: retrying in ${waitMs}ms`
  };
}

/** The default wait: a timer that loses the race to the request's abort signal. */
const abortableSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('aborted during backoff'), { name: 'AbortError' }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(Object.assign(new Error('aborted during backoff'), { name: 'AbortError' }));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export async function withRetry<T>(
  fn: () => Promise<T>,
  { policy, signal, onRetry, sleep = abortableSleep }: WithRetryOptions
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const decision = decideRetry(err, attempt, policy);
      if (!decision.retry) throw err;
      const status = statusOf(err);
      onRetry?.({
        attempt,
        waitMs: decision.waitMs,
        ...(status !== undefined ? { status } : {}),
        reason: decision.reason
      });
      await sleep(decision.waitMs, signal);
    }
  }
}
