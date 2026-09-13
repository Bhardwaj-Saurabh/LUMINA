/**
 * Shared scripted fakes for @lumina/agent tests — lumina-tdd taxonomy: fake ports over SDK
 * mocks, array-collecting AskEmitter. This file is test infrastructure (fully implemented
 * in the red phase); it never touches network, Mongo, env, real time, or randomness.
 *
 * The port shapes below are the NEUTRAL contracts the loop consumes, deliberately
 * provider-agnostic: `toolCalls` + `stopReason: 'tool_use' | 'end_turn'` map 1:1 onto both
 * Azure OpenAI `tool_calls`/`finish_reason` and Anthropic `tool_use`/`stop_reason`, and the
 * single `tool_results` message role maps onto Anthropic's user-message tool_result blocks
 * and Azure's role:'tool' messages alike.
 *
 * Green phase homes these types in `providers/llm/port.ts` (ARCHITECTURE.md §2.2 — that file
 * is the only allowed importer of SDKs). Production code must NEVER import from src/testing/;
 * structural typing connects the fake to the real port interface.
 */
import type {
  DoneEvent,
  PlanEvent,
  SourcesEvent,
  SseEventName,
  StreamErrorEvent,
  TokenEvent,
  TraceEvent
} from '@lumina/contract';
import type {
  LlmMessage,
  LlmPort,
  LlmUsage,
  RunTurnInput,
  RunTurnResult,
  ToolCallRequest
} from '../providers/llm/port.js';

export type {
  LlmMessage,
  LlmPort,
  LlmToolSpec,
  LlmUsage,
  RunTurnInput,
  RunTurnResult,
  ToolCallRequest,
  ToolResultPart
} from '../providers/llm/port.js';

/**
 * Legacy one-shot synthesis shapes, declared locally (structurally identical to the ones
 * in port.ts) rather than imported: once the loop answers inside `streamTurn`, nothing
 * needs `streamText`, and green should be free to delete it from the port and the Azure
 * adapter without breaking the fakes.
 */
export interface StreamTextInput {
  system: string;
  messages: LlmMessage[];
  signal?: AbortSignal;
}

export interface TextStream {
  stream: AsyncIterable<string>;
  usage(): Promise<LlmUsage>;
}

// ---------------------------------------------------------------------------
// AskEmitter — ARCHITECTURE.md §3.1 "SSE decoupling": the loop receives this
// interface, never an Express Response. http/sseSink.ts implements it in green.
// ---------------------------------------------------------------------------

export interface AskEmitter {
  plan(data: PlanEvent): void;
  trace(data: TraceEvent): void;
  sources(data: SourcesEvent): void;
  token(data: TokenEvent): void;
  done(data: DoneEvent): void;
  error(data: StreamErrorEvent): void;
}

export interface EmittedFrame {
  event: SseEventName;
  data: unknown;
}

export interface CollectingEmitter extends AskEmitter {
  /** Every emitted frame in order, for assertions against the contract schemas. */
  events: EmittedFrame[];
}

export function collectingEmitter(): CollectingEmitter {
  const events: EmittedFrame[] = [];
  return {
    events,
    plan(data) {
      events.push({ event: 'plan', data });
    },
    trace(data) {
      events.push({ event: 'trace', data });
    },
    sources(data) {
      events.push({ event: 'sources', data });
    },
    token(data) {
      events.push({ event: 'token', data });
    },
    done(data) {
      events.push({ event: 'done', data });
    },
    error(data) {
      events.push({ event: 'error', data });
    }
  };
}

// ---------------------------------------------------------------------------
// LlmPort — neutral turn-based shape, homed in providers/llm/port.ts and
// re-exported above (see file header for the provider mapping).
// ---------------------------------------------------------------------------
// scriptedLlm — a queue of scripted turns, consumed by `streamTurn` (the shape the
// optimistic-streaming loop uses for research AND synthesis in ONE round trip) and by
// the legacy non-streaming `runTurn` / `streamText` alike.
// ---------------------------------------------------------------------------

/**
 * ONE turn, streamed. Homed in `providers/llm/port.ts` next to `RunTurnResult`:
 *
 *   stream    assistant text deltas, IF this turn answers rather than calling tools.
 *             A research turn yields nothing.
 *   result()  the completed turn: toolCalls (possibly empty), stopReason, usage.
 *             Resolves only once the stream is drained — a real provider sends
 *             stop_reason/usage last, so the loop must iterate before it can decide.
 */
export type { TurnStream } from '../providers/llm/port.js';

/** `LlmPort` gains `streamTurn` (and keeps `runTurn`); kept as a name the tests can use. */
export type StreamingLlmPort = Pick<LlmPort, 'streamTurn'>;

/**
 * A scripted turn. `deltas` present ⇒ the turn ANSWERS; `toolCalls` present ⇒ it
 * RESEARCHES; both present ⇒ the model illegally mixed narration with tool calls (the
 * deltas stream first, the tool calls arrive with the result). `stopReason` is derived
 * from `toolCalls` unless stated.
 */
export type ScriptedTurn =
  | {
      deltas?: string[];
      toolCalls?: ToolCallRequest[];
      text?: string;
      stopReason?: 'tool_use' | 'end_turn';
      usage?: LlmUsage;
    }
  | { throws: Error };

export type ScriptedSynthesis = { deltas: string[]; usage?: LlmUsage } | { throws: Error };

export interface ScriptedLlm extends LlmPort, StreamingLlmPort {
  /** Snapshot of every streamTurn input, so tests can pin exactly what the model was shown. */
  streamTurnCalls: RunTurnInput[];
  runTurnCalls: RunTurnInput[];
  streamTextCalls: StreamTextInput[];
  /** Legacy one-shot synthesis, kept on the fake alone: the port no longer carries it. */
  streamText(input: StreamTextInput): TextStream;
}

const ZERO_USAGE: LlmUsage = { in: 0, out: 0 };

export function scriptedLlm(
  turns: ScriptedTurn[],
  synthesis: ScriptedSynthesis = { deltas: [] }
): ScriptedLlm {
  const queue = [...turns];
  const streamTurnCalls: RunTurnInput[] = [];
  const runTurnCalls: RunTurnInput[] = [];
  const streamTextCalls: StreamTextInput[] = [];

  // Shallow-copy the arrays: the loop reuses/mutates its own message array later, and
  // assertions need what the model saw AT THIS CALL.
  const snapshot = (input: RunTurnInput): RunTurnInput => ({
    system: input.system,
    messages: [...input.messages],
    tools: [...input.tools]
  });

  const resultOf = (turn: Exclude<ScriptedTurn, { throws: Error }>): RunTurnResult => {
    const toolCalls = turn.toolCalls ?? [];
    const text = turn.text ?? (turn.deltas ? turn.deltas.join('') : undefined);
    return {
      toolCalls,
      ...(text !== undefined ? { text } : {}),
      stopReason: turn.stopReason ?? (toolCalls.length > 0 ? 'tool_use' : 'end_turn'),
      usage: turn.usage ?? ZERO_USAGE
    };
  };

  return {
    streamTurnCalls,
    runTurnCalls,
    streamTextCalls,
    streamTurn(input) {
      streamTurnCalls.push(snapshot(input));
      const turn = queue.shift();
      if (!turn) throw new Error('scriptedLlm: streamTurn called more times than scripted');
      if ('throws' in turn) {
        const err = turn.throws;
        return {
          // eslint-disable-next-line require-yield
          stream: (async function* (): AsyncGenerator<string> {
            throw err;
          })(),
          result: () => Promise.reject(err)
        };
      }
      let done!: () => void;
      const drained = new Promise<void>((resolve) => {
        done = resolve;
      });
      return {
        stream: (async function* () {
          try {
            for (const delta of turn.deltas ?? []) yield delta;
          } finally {
            done();
          }
        })(),
        result: async () => {
          await drained;
          return resultOf(turn);
        }
      };
    },
    async runTurn(input) {
      runTurnCalls.push(snapshot(input));
      const turn = queue.shift();
      if (!turn) throw new Error('scriptedLlm: runTurn called more times than scripted');
      if ('throws' in turn) throw turn.throws;
      return resultOf(turn);
    },
    streamText(input) {
      streamTextCalls.push({ system: input.system, messages: [...input.messages] });
      if ('throws' in synthesis) {
        const err = synthesis.throws;
        return {
          // eslint-disable-next-line require-yield
          stream: (async function* (): AsyncGenerator<string> {
            throw err;
          })(),
          usage: () => Promise.reject(err)
        };
      }
      const s = synthesis;
      return {
        stream: (async function* () {
          for (const delta of s.deltas) yield delta;
        })(),
        usage: () => Promise.resolve(s.usage ?? ZERO_USAGE)
      };
    }
  };
}

// ---------------------------------------------------------------------------
// SearchPort + fetch-page fakes — scripted result queues, no network ever.
// ---------------------------------------------------------------------------

export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
}

export interface SearchPort {
  search(query: string, opts?: { maxResults?: number }): Promise<SearchResult[]>;
}

export interface ScriptedSearchPort extends SearchPort {
  calls: Array<{ query: string; opts?: { maxResults?: number } }>;
}

/** Each call consumes the next scripted result set; an Error entry makes that call throw. */
export function scriptedSearch(resultSets: Array<SearchResult[] | Error>): ScriptedSearchPort {
  const queue = [...resultSets];
  const calls: Array<{ query: string; opts?: { maxResults?: number } }> = [];
  return {
    calls,
    async search(query, opts) {
      calls.push({ query, ...(opts !== undefined ? { opts } : {}) });
      const next = queue.shift();
      if (next === undefined) throw new Error('scriptedSearch: search called more times than scripted');
      if (next instanceof Error) throw next;
      return next;
    }
  };
}

export interface FetchedPage {
  url: string;
  title: string;
  text: string;
}

export interface FetchPagePort {
  fetchPage(url: string): Promise<FetchedPage>;
}

export interface ScriptedFetchPagePort extends FetchPagePort {
  calls: string[];
}

/**
 * Scripted fetch_page backing. ARCHITECTURE.md folds extraction into the search provider
 * (tavily search + extract); green may merge this into SearchPort — the fake stands alone.
 */
export function scriptedFetchPage(pages: Array<FetchedPage | Error>): ScriptedFetchPagePort {
  const queue = [...pages];
  const calls: string[] = [];
  return {
    calls,
    async fetchPage(url) {
      calls.push(url);
      const next = queue.shift();
      if (next === undefined) throw new Error('scriptedFetchPage: fetchPage called more times than scripted');
      if (next instanceof Error) throw next;
      return next;
    }
  };
}
