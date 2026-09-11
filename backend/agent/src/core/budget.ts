/**
 * Budget — ARCHITECTURE.md §3.1: one object per request, four dimensions (tool calls,
 * wall clock, tokens, USD), with a synthesis/finalization allowance reserved before any
 * research is admitted. Reservation is check+increment in one synchronous step.
 *
 * Budget reports state only. Mapping to terminated:'cap' is the orchestrator's job and
 * requires a REFUSED admission while the model still wanted tools — mere exhaustion after
 * a natural end_turn is not a cap.
 */

export type BudgetExceededReason = 'cost' | 'tokens' | 'deadline' | 'toolCalls';

export interface BudgetOptions {
  maxToolCalls: number;
  deadlineMs: number;
  maxUsd: number;
  /** Shared in+out run total. */
  maxTokens: number;
  /** Time/cost reserved for synthesis + durable finalization; refuses research, not the finish. */
  synthesisAllowance: { ms: number; usd: number };
  now: () => number;
}

export interface BudgetUsage {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export interface BudgetSnapshot {
  tokens: { in: number; out: number };
  costUsd: number;
}

export class Budget {
  private readonly opts: BudgetOptions;
  private readonly startedAt: number;
  private toolCallsUsed = 0;
  private tokensIn = 0;
  private tokensOut = 0;
  private costUsd = 0;

  constructor(opts: BudgetOptions) {
    this.opts = opts;
    this.startedAt = opts.now();
  }

  /** Synchronous: no await between check and increment, or two researchers share the last slot. */
  tryReserveToolCall(): boolean {
    if (this.exceeded()) return false;
    if (this.toolCallsUsed >= this.opts.maxToolCalls) return false;
    const { ms, usd } = this.opts.synthesisAllowance;
    if (this.remainingMs() <= ms) return false;
    if (this.opts.maxUsd - this.costUsd <= usd) return false;
    this.toolCallsUsed += 1;
    return true;
  }

  remainingMs(): number {
    return Math.max(0, this.opts.deadlineMs - (this.opts.now() - this.startedAt));
  }

  recordUsage({ tokensIn, tokensOut, costUsd }: BudgetUsage): void {
    this.tokensIn += tokensIn;
    this.tokensOut += tokensOut;
    this.costUsd += costUsd;
  }

  exceeded(): boolean {
    return this.exceededReason() !== null;
  }

  exceededReason(): BudgetExceededReason | null {
    if (this.costUsd > this.opts.maxUsd) return 'cost';
    if (this.tokensIn + this.tokensOut > this.opts.maxTokens) return 'tokens';
    if (this.opts.now() - this.startedAt > this.opts.deadlineMs) return 'deadline';
    if (this.toolCallsUsed >= this.opts.maxToolCalls) return 'toolCalls';
    return null;
  }

  snapshot(): BudgetSnapshot {
    return { tokens: { in: this.tokensIn, out: this.tokensOut }, costUsd: this.costUsd };
  }
}
