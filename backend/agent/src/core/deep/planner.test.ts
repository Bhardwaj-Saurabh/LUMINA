/**
 * M8 batch A — the deep planner (`core/deep/planner.ts`, ARCHITECTURE.md §2.2).
 *
 * The planner makes ONE non-streaming `runTurn` that advertises only `plan_research` with
 * `toolChoice: 'required'`, and reads the sub-questions out of that tool call's input. It
 * returns a `PlanEvent` — so every assertion about the SHAPE parses with the contract's own
 * zod schema rather than restating it.
 *
 * Everything is injected: the LLM is the shared `scriptedLlm` fake, the price function and the
 * budget are hand-written collectors. No SDK, no network, no clock, no randomness.
 */
import { PlanEvent } from '@lumina/contract';
import { describe, expect, it } from 'vitest';
import { scriptedLlm, type ScriptedTurn, type ToolCallRequest } from '../../testing/fakes.js';
import { planResearch, type PlannerDeps } from './planner.js';

/** Collects what the planner charged, so a test can prove the plan's spend is accounted. */
function recordingBudget(): {
  recordUsage(u: { tokensIn: number; tokensOut: number; costUsd: number }): void;
  entries: Array<{ tokensIn: number; tokensOut: number; costUsd: number }>;
} {
  const entries: Array<{ tokensIn: number; tokensOut: number; costUsd: number }> = [];
  return {
    entries,
    recordUsage(u) {
      entries.push({ ...u });
    }
  };
}

/** One scripted `plan_research` tool call carrying whatever the "model" decided. */
function planCall(subQuestions: unknown, extra: Record<string, unknown> = {}): ToolCallRequest {
  return { id: 'call_plan_1', name: 'plan_research', input: { subQuestions, ...extra } };
}

function deps(
  turns: ScriptedTurn[],
  over: Partial<PlannerDeps> = {}
): PlannerDeps & { budget: ReturnType<typeof recordingBudget>; llm: ReturnType<typeof scriptedLlm> } {
  const llm = over.llm ? (over.llm as ReturnType<typeof scriptedLlm>) : scriptedLlm(turns);
  const budget = (over.budget as ReturnType<typeof recordingBudget>) ?? recordingBudget();
  return {
    ...over,
    llm,
    budget,
    min: over.min ?? 3,
    max: over.max ?? 6,
    price: over.price ?? (() => 0)
  };
}

describe('planResearch', () => {
  it('returns a contract-valid PlanEvent whose indices are renumbered contiguously from 1', async () => {
    // The model numbered them 0, 5, 5 — every downstream `[n]` and every trace step's
    // `subQuestion` is keyed on `i`, so duplicates or a zero would corrupt attribution.
    const d = deps([
      {
        toolCalls: [
          planCall([
            { i: 0, question: 'What is the current rate?' },
            { i: 5, question: 'How has it moved this year?' },
            { i: 5, question: 'What do forecasters expect?' }
          ])
        ]
      }
    ]);

    const plan = await planResearch('where are rates going?', d);

    expect(PlanEvent.parse(plan)).toEqual(plan);
    expect(plan.subQuestions.map((sq) => sq.i)).toEqual([1, 2, 3]);
    expect(plan.subQuestions.map((sq) => sq.question)).toEqual([
      'What is the current rate?',
      'How has it moved this year?',
      'What do forecasters expect?'
    ]);
  });

  it('makes exactly one provider call advertising only plan_research with toolChoice required', async () => {
    // A planner that merely ASKS the model to plan can be declined; `required` makes the
    // decomposition a property of the request.
    const d = deps([
      {
        toolCalls: [
          planCall([{ i: 1, question: 'a' }, { i: 2, question: 'b' }, { i: 3, question: 'c' }])
        ]
      }
    ]);

    await planResearch('q', d);

    expect(d.llm.runTurnCalls).toHaveLength(1);
    expect(d.llm.streamTurnCalls).toHaveLength(0);
    expect(d.llm.runTurnCalls[0]!.tools.map((t) => t.name)).toEqual(['plan_research']);
    expect(d.llm.runTurnCalls[0]!.toolChoice).toBe('required');
  });

  it('truncates more than max sub-questions down to max', async () => {
    // Deep is allowed to cost more than quick; it is not allowed to be unbounded.
    const d = deps(
      [
        {
          toolCalls: [
            planCall(
              Array.from({ length: 9 }, (_, n) => ({ i: n + 1, question: `question ${n + 1}` }))
            )
          ]
        }
      ],
      { max: 6 }
    );

    const plan = await planResearch('q', d);

    expect(plan.subQuestions).toHaveLength(6);
    expect(plan.subQuestions.map((sq) => sq.question)).toEqual([
      'question 1',
      'question 2',
      'question 3',
      'question 4',
      'question 5',
      'question 6'
    ]);
    expect(plan.subQuestions.map((sq) => sq.i)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('drops blank and whitespace-only sub-questions before the count is checked', async () => {
    const d = deps(
      [
        {
          toolCalls: [
            planCall([
              { i: 1, question: 'real one' },
              { i: 2, question: '   ' },
              { i: 3, question: '' },
              { i: 4, question: 'real two' },
              { i: 5, question: '\n\t ' },
              { i: 6, question: 'real three' }
            ])
          ]
        }
      ],
      { min: 3 }
    );

    const plan = await planResearch('q', d);

    expect(plan.subQuestions.map((sq) => sq.question)).toEqual(['real one', 'real two', 'real three']);
    expect(plan.subQuestions.map((sq) => sq.i)).toEqual([1, 2, 3]);
  });

  it('dedupes exact duplicate sub-questions ignoring case and surrounding whitespace', async () => {
    // Two identical sub-questions are one search billed twice.
    const d = deps(
      [
        {
          toolCalls: [
            planCall([
              { i: 1, question: 'What is the current rate?' },
              { i: 2, question: '  what is the CURRENT rate?  ' },
              { i: 3, question: 'What do forecasters expect?' },
              { i: 4, question: 'Who sets the rate?' }
            ])
          ]
        }
      ],
      { min: 3 }
    );

    const plan = await planResearch('q', d);

    expect(plan.subQuestions.map((sq) => sq.question)).toEqual([
      'What is the current rate?',
      'What do forecasters expect?',
      'Who sets the rate?'
    ]);
    expect(plan.subQuestions.map((sq) => sq.i)).toEqual([1, 2, 3]);
  });

  it('rejects when fewer than min usable sub-questions survive, naming the shortfall', async () => {
    // A deep search that cannot decompose the question is a quick search that costs more:
    // fail loud (A1) rather than silently falling back to the raw query.
    const d = deps(
      [
        {
          toolCalls: [
            planCall([
              { i: 1, question: 'only one' },
              { i: 2, question: '   ' },
              { i: 3, question: 'ONLY ONE' }
            ])
          ]
        }
      ],
      { min: 3 }
    );

    await expect(planResearch('q', d)).rejects.toThrow(/3/);
    await expect(planResearch('q', deps([{ toolCalls: [planCall([{ i: 1, question: 'x' }])] }]))).rejects.toThrow(
      /sub-?questions?/i
    );
  });

  it('rejects when the turn contains no plan_research call at all', async () => {
    const d = deps([{ text: 'I would rather just answer.', stopReason: 'end_turn' }]);

    await expect(planResearch('q', d)).rejects.toThrow(/plan_research/);
  });

  it('records the planner turn tokens and cost against the injected budget', async () => {
    // Deep's plan is real spend and must show up in done.costUsd.
    const priced: Array<{ in: number; out: number }> = [];
    const d = deps(
      [
        {
          toolCalls: [
            planCall([{ i: 1, question: 'a' }, { i: 2, question: 'b' }, { i: 3, question: 'c' }])
          ],
          usage: { in: 420, out: 130 }
        }
      ],
      {
        price: (u) => {
          priced.push({ ...u });
          return 0.0042;
        }
      }
    );

    await planResearch('q', d);

    expect(priced).toEqual([{ in: 420, out: 130 }]);
    expect(d.budget.entries).toEqual([{ tokensIn: 420, tokensOut: 130, costUsd: 0.0042 }]);
  });

  it('carries a supplied reason through and omits the key entirely when the model gave none', async () => {
    const d = deps([
      {
        toolCalls: [
          planCall([
            { i: 1, question: 'a', reason: 'establishes the baseline' },
            { i: 2, question: 'b' },
            { i: 3, question: 'c', reason: '   ' }
          ])
        ]
      }
    ]);

    const plan = await planResearch('q', d);

    expect(plan.subQuestions[0]!.reason).toBe('establishes the baseline');
    expect(plan.subQuestions[1]).not.toHaveProperty('reason');
    expect(plan.subQuestions[2]).not.toHaveProperty('reason');
  });

  it('forwards the abort signal to the provider turn so deep’s deadline reaches the planner', async () => {
    const controller = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    const inner = scriptedLlm([
      {
        toolCalls: [
          planCall([{ i: 1, question: 'a' }, { i: 2, question: 'b' }, { i: 3, question: 'c' }])
        ]
      }
    ]);
    const llm = {
      runTurn: (input: Parameters<typeof inner.runTurn>[0]) => {
        seen.push(input.signal);
        return inner.runTurn(input);
      }
    };

    await planResearch('q', deps([], { llm: llm as never, signal: controller.signal }));

    expect(seen).toEqual([controller.signal]);
  });
});
