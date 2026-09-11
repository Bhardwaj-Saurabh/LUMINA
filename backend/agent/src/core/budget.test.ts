import { describe, expect, it } from 'vitest';
import { DoneEvent } from '@lumina/contract';
import { Budget } from './budget.js';

/**
 * Budget — ARCHITECTURE.md §3.1: one object per request, four dimensions (tool calls,
 * wall clock, tokens, USD) checked at every decision point, with a synthesis/finalization
 * allowance reserved before any research is admitted.
 *
 * Determinism: the clock is injected as `now()`; no test touches real time.
 */

interface Clock {
  now: () => number;
  advance: (ms: number) => void;
}

function fakeClock(startMs = 0): Clock {
  let t = startMs;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    }
  };
}

/** Quick-gear defaults per §3.1 budget table; allowance zeroed unless a test is about it. */
function quickBudget(clock: Clock, overrides: Record<string, unknown> = {}) {
  return new Budget({
    maxToolCalls: 8,
    deadlineMs: 90_000,
    maxUsd: 0.05,
    maxTokens: 180_000,
    synthesisAllowance: { ms: 0, usd: 0 },
    now: clock.now,
    ...overrides
  });
}

describe('Budget tool-call reservation', () => {
  it('admits reservations synchronously (boolean, not a promise) while under the call cap', () => {
    const budget = quickBudget(fakeClock());
    const first = budget.tryReserveToolCall();
    // A Promise would fail both of these: reservation must be check+increment in one
    // synchronous step, or two concurrent researchers can both pass the same last slot.
    expect(first).toBe(true);
    expect(typeof first).toBe('boolean');
  });

  it('admits exactly maxToolCalls sequential reservations and refuses the next one', () => {
    const budget = quickBudget(fakeClock());
    const admitted: boolean[] = [];
    for (let i = 0; i < 8; i++) admitted.push(budget.tryReserveToolCall());
    expect(admitted).toEqual([true, true, true, true, true, true, true, true]);
    expect(budget.tryReserveToolCall()).toBe(false);
  });

  it('reports exceeded with reason toolCalls once the call cap is consumed', () => {
    const budget = quickBudget(fakeClock());
    for (let i = 0; i < 8; i++) budget.tryReserveToolCall();
    expect(budget.exceeded()).toBe(true);
    expect(budget.exceededReason()).toBe('toolCalls');
  });

  it('is not exceeded and has no reason while every dimension is under its cap', () => {
    const budget = quickBudget(fakeClock());
    budget.tryReserveToolCall();
    budget.recordUsage({ tokensIn: 100, tokensOut: 50, costUsd: 0.001 });
    expect(budget.exceeded()).toBe(false);
    expect(budget.exceededReason()).toBeNull();
  });
});

describe('Budget wall-clock deadline (injected clock, no real time)', () => {
  it('starts with the full deadline remaining and shrinks as the clock advances', () => {
    const clock = fakeClock(1_000);
    const budget = quickBudget(clock);
    expect(budget.remainingMs()).toBe(90_000);
    clock.advance(60_000);
    expect(budget.remainingMs()).toBe(30_000);
  });

  it('becomes exceeded with reason deadline once the wall-clock cap has passed', () => {
    const clock = fakeClock();
    const budget = quickBudget(clock);
    clock.advance(90_001);
    expect(budget.exceeded()).toBe(true);
    expect(budget.exceededReason()).toBe('deadline');
  });

  it('refuses a tool-call reservation attempted after the deadline', () => {
    const clock = fakeClock();
    const budget = quickBudget(clock);
    expect(budget.tryReserveToolCall()).toBe(true);
    clock.advance(90_001);
    expect(budget.tryReserveToolCall()).toBe(false);
  });
});

describe('Budget usage accounting (tokens, USD)', () => {
  it('accumulates recorded usage across calls', () => {
    const budget = quickBudget(fakeClock());
    budget.recordUsage({ tokensIn: 1_000, tokensOut: 200, costUsd: 0.004 });
    budget.recordUsage({ tokensIn: 2_000, tokensOut: 300, costUsd: 0.006 });
    const snap = budget.snapshot();
    expect(snap.tokens).toEqual({ in: 3_000, out: 500 });
    expect(snap.costUsd).toBeCloseTo(0.01, 10);
  });

  it('becomes exceeded with reason cost when accumulated USD passes maxUsd', () => {
    const budget = quickBudget(fakeClock());
    budget.recordUsage({ tokensIn: 10, tokensOut: 10, costUsd: 0.03 });
    expect(budget.exceeded()).toBe(false);
    budget.recordUsage({ tokensIn: 10, tokensOut: 10, costUsd: 0.03 });
    expect(budget.exceeded()).toBe(true);
    expect(budget.exceededReason()).toBe('cost');
  });

  it('becomes exceeded with reason tokens when the shared in+out total passes maxTokens', () => {
    const budget = quickBudget(fakeClock(), { maxTokens: 1_000 });
    budget.recordUsage({ tokensIn: 600, tokensOut: 300, costUsd: 0 });
    expect(budget.exceeded()).toBe(false);
    budget.recordUsage({ tokensIn: 100, tokensOut: 100, costUsd: 0 });
    expect(budget.exceeded()).toBe(true);
    expect(budget.exceededReason()).toBe('tokens');
  });

  it('refuses a tool-call reservation once the USD ceiling is hit before the call cap', () => {
    const budget = quickBudget(fakeClock());
    expect(budget.tryReserveToolCall()).toBe(true); // only 1 of 8 calls used
    budget.recordUsage({ tokensIn: 10, tokensOut: 10, costUsd: 0.06 });
    expect(budget.tryReserveToolCall()).toBe(false);
    expect(budget.exceededReason()).toBe('cost');
  });
});

describe('Budget reserves the finish before researching (synthesis allowance)', () => {
  it('stops admitting research when remaining time is within the synthesis time allowance, without being exceeded', () => {
    const clock = fakeClock();
    const budget = quickBudget(clock, {
      deadlineMs: 240_000,
      maxToolCalls: 24,
      maxUsd: 0.35,
      synthesisAllowance: { ms: 30_000, usd: 0 }
    });
    clock.advance(200_000); // 40 s remain > 30 s allowance: research still admitted
    expect(budget.tryReserveToolCall()).toBe(true);
    clock.advance(15_000); // 25 s remain <= 30 s allowance: the finish is reserved
    expect(budget.tryReserveToolCall()).toBe(false);
    // The absolute deadline has NOT passed: this is a research stop, not a blown budget.
    expect(budget.exceeded()).toBe(false);
  });

  it('stops admitting research when remaining USD is within the synthesis cost allowance, without being exceeded', () => {
    const budget = quickBudget(fakeClock(), {
      maxToolCalls: 24,
      maxUsd: 0.35,
      synthesisAllowance: { ms: 0, usd: 0.05 }
    });
    budget.recordUsage({ tokensIn: 10, tokensOut: 10, costUsd: 0.29 }); // 0.06 remains > 0.05
    expect(budget.tryReserveToolCall()).toBe(true);
    budget.recordUsage({ tokensIn: 10, tokensOut: 10, costUsd: 0.02 }); // 0.04 remains <= 0.05
    expect(budget.tryReserveToolCall()).toBe(false);
    expect(budget.exceeded()).toBe(false);
  });
});

describe('Budget snapshot feeds the done event', () => {
  it('returns totals that slot directly into a contract-valid DoneEvent', () => {
    const clock = fakeClock();
    const budget = quickBudget(clock);
    budget.recordUsage({ tokensIn: 1_234, tokensOut: 567, costUsd: 0.012 });
    clock.advance(4_200);
    const snap = budget.snapshot();

    const done = DoneEvent.safeParse({
      answerId: 'ans_test1',
      latencyMs: 4_200,
      ttftMs: 900,
      model: 'claude-sonnet-5',
      tokens: snap.tokens,
      costUsd: snap.costUsd,
      searchCached: false,
      terminated: 'done',
      depth: 'quick'
    });
    expect(done.success).toBe(true);
    expect(snap.tokens).toEqual({ in: 1_234, out: 567 });
    expect(snap.costUsd).toBeCloseTo(0.012, 10);
  });
});
