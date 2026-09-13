/**
 * The deep planner — ARCHITECTURE.md §2.2 / §3.2. ONE non-streaming turn that must decompose.
 *
 * The decomposition is a property of the REQUEST, not of the prompt: the turn advertises only
 * `plan_research` with `toolChoice: 'required'`, so a model that would rather just answer
 * cannot decline. The sub-questions come out of the tool call's arguments — typed, named by a
 * real JSON Schema — rather than out of prose we would have to guess at.
 *
 * A plan that cannot be made is an error, never a silent fall back to the raw query (A1):
 * a deep search that skips its decomposition is a quick search that costs six times as much.
 */
import type { PlanEvent, SubQuestion } from '@lumina/contract';
import type { LlmPort, LlmToolSpec, LlmUsage } from '../../providers/llm/port.js';

export interface PlannerDeps {
  llm: Pick<LlmPort, 'runTurn'>;
  min: number;
  max: number;
  price: (usage: LlmUsage) => number;
  budget: { recordUsage(u: { tokensIn: number; tokensOut: number; costUsd: number }): void };
  signal?: AbortSignal;
}

const SYSTEM =
  'You are LUMINA planning a DEEP search. Break the user question into independent, ' +
  'separately searchable sub-questions that together cover it — no overlaps, no restatements ' +
  'of the question itself. Each carries a short reason for why it is needed. Call ' +
  'plan_research exactly once; do not answer the question.\n' +
  'Keep each sub-question to ONE short line, phrased the way you would type it into a ' +
  'search box, and each reason to a brief clause. Two reasons: the plan is streamed before ' +
  'anything else happens, so its length is the user\'s first wait; and a sub-question that ' +
  'reads like a paragraph makes a poor search query.';

const PLAN_TOOL: LlmToolSpec = {
  name: 'plan_research',
  description:
    'Commit to the sub-questions this deep search will research, in the order they should be ' +
    'investigated. Call this exactly once, before any retrieval.',
  inputSchema: {
    type: 'object',
    properties: {
      subQuestions: {
        type: 'array',
        description: 'The sub-questions, most foundational first.',
        items: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description: 'A single, self-contained, searchable question.'
            },
            reason: {
              type: 'string',
              description: 'Why answering this is needed to answer the user question.'
            }
          },
          required: ['question'],
          additionalProperties: false
        }
      }
    },
    required: ['subQuestions'],
    additionalProperties: false
  }
};

/** Case- and whitespace-insensitive identity: two spellings of one question are one search. */
const dedupeKey = (question: string): string => question.toLowerCase().replace(/\s+/g, ' ');

const asText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

export async function planResearch(query: string, deps: PlannerDeps): Promise<PlanEvent> {
  const turn = await deps.llm.runTurn({
    system: SYSTEM,
    messages: [{ role: 'user', content: query }],
    tools: [PLAN_TOOL],
    toolChoice: 'required',
    ...(deps.signal ? { signal: deps.signal } : {})
  });

  // Billed whether or not we like the answer: account for it BEFORE any rejection, so a
  // refused plan still shows up in done.costUsd.
  deps.budget.recordUsage({
    tokensIn: turn.usage.in,
    tokensOut: turn.usage.out,
    costUsd: deps.price(turn.usage)
  });

  const call = turn.toolCalls.find((c) => c.name === 'plan_research');
  if (!call) throw new Error('deep planning failed: the turn called no plan_research tool');

  const raw = call.input.subQuestions;
  const proposed = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  const subQuestions: SubQuestion[] = [];
  for (const entry of proposed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const question = asText((entry as Record<string, unknown>).question);
    if (!question) continue;
    const key = dedupeKey(question);
    if (seen.has(key)) continue;
    seen.add(key);
    const reason = asText((entry as Record<string, unknown>).reason);
    // Renumbered contiguously from 1: every trace step's and source's `subQuestion` is keyed
    // on `i`, so whatever the model numbered them is discarded.
    subQuestions.push({ i: subQuestions.length + 1, question, ...(reason ? { reason } : {}) });
    if (subQuestions.length === deps.max) break;
  }

  if (subQuestions.length < deps.min) {
    throw new Error(
      `deep planning failed: ${subQuestions.length} usable sub-questions, min ${deps.min}`
    );
  }
  return { subQuestions };
}
