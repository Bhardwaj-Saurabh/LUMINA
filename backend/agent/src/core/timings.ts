/**
 * Per-request phase timings — the instrument behind the TTFT work (ARCHITECTURE §9.1).
 *
 * `ttftMs` is one number; this is where it goes. Both gears report the same shape so the
 * aggregator can say "X ms of the p95 is the decision turn, Y the tools, Z the answer's
 * first delta" instead of guessing. Deliberately OFF the SSE contract and off the run log:
 * it rides on the per-answer log line and the `requests` row, which are ours.
 */
import type { LlmToolChoice, LlmUsage } from '../providers/llm/port.js';

export interface TurnTiming {
  /** 1-based order of the LLM round trip within the request. */
  index: number;
  toolChoice: LlmToolChoice;
  /** Tool names advertised on this turn (what the model could pick). */
  advertised: string[];
  /** Start → `result()` resolved. */
  ms: number;
  /** Start → first text delta, present only on a turn that answered. */
  firstDeltaMs?: number;
  /** Tool names the model asked for on this turn ([] on an answer turn). */
  toolCalls: string[];
  usage: LlmUsage;
}

export interface ToolPhaseTiming {
  /** The turn whose calls this phase executed. */
  turn: number;
  /** Wall-clock of the concurrent batch (the slowest call, not the sum). */
  ms: number;
  tools: string[];
}

export interface RunTimings {
  turns: TurnTiming[];
  toolPhases: ToolPhaseTiming[];
  /** Convenience roll-ups for the aggregator. */
  turnCount: number;
  turn1Ms?: number;
  /** Sum of the tool phases before the first token. */
  toolsMs: number;
  /** The answering turn's start → first delta. */
  answerFirstDeltaMs?: number;
  /** Deep only. */
  planMs?: number;
  fanOutMs?: number;
}

/** Accumulates turn/phase records and derives the roll-ups; one per request. */
export class TimingsRecorder {
  private readonly turns: TurnTiming[] = [];
  private readonly toolPhases: ToolPhaseTiming[] = [];
  private planMs?: number;
  private fanOutMs?: number;

  turn(record: Omit<TurnTiming, 'index'>): TurnTiming {
    const entry: TurnTiming = { index: this.turns.length + 1, ...record };
    this.turns.push(entry);
    return entry;
  }

  toolPhase(record: ToolPhaseTiming): void {
    this.toolPhases.push(record);
  }

  plan(ms: number): void {
    this.planMs = ms;
  }

  fanOut(ms: number): void {
    this.fanOutMs = ms;
  }

  build(): RunTimings {
    const answered = this.turns.find((t) => t.firstDeltaMs !== undefined);
    const first = this.turns[0];
    return {
      turns: this.turns,
      toolPhases: this.toolPhases,
      turnCount: this.turns.length,
      ...(first ? { turn1Ms: first.ms } : {}),
      toolsMs: this.toolPhases.reduce((sum, p) => sum + p.ms, 0),
      ...(answered?.firstDeltaMs !== undefined ? { answerFirstDeltaMs: answered.firstDeltaMs } : {}),
      ...(this.planMs !== undefined ? { planMs: this.planMs } : {}),
      ...(this.fanOutMs !== undefined ? { fanOutMs: this.fanOutMs } : {})
    };
  }
}
