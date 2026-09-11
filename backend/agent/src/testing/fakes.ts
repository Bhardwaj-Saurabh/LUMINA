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
  LlmPort,
  LlmUsage,
  RunTurnInput,
  StreamTextInput,
  ToolCallRequest
} from '../providers/llm/port.js';

export type {
  LlmMessage,
  LlmPort,
  LlmToolSpec,
  LlmUsage,
  RunTurnInput,
  RunTurnResult,
  StreamTextInput,
  TextStream,
  ToolCallRequest,
  ToolResultPart
} from '../providers/llm/port.js';

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
// scriptedLlm — a queue of scripted turn results plus a scripted synthesis stream.
// ---------------------------------------------------------------------------

export type ScriptedTurn =
  | {
      toolCalls?: ToolCallRequest[];
      text?: string;
      stopReason: 'tool_use' | 'end_turn';
      usage?: LlmUsage;
    }
  | { throws: Error };

export type ScriptedSynthesis = { deltas: string[]; usage?: LlmUsage } | { throws: Error };

export interface ScriptedLlm extends LlmPort {
  /** Snapshot of every runTurn input, so tests can pin exactly what the model was shown. */
  runTurnCalls: RunTurnInput[];
  streamTextCalls: StreamTextInput[];
}

const ZERO_USAGE: LlmUsage = { in: 0, out: 0 };

export function scriptedLlm(
  turns: ScriptedTurn[],
  synthesis: ScriptedSynthesis = { deltas: [] }
): ScriptedLlm {
  const queue = [...turns];
  const runTurnCalls: RunTurnInput[] = [];
  const streamTextCalls: StreamTextInput[] = [];
  return {
    runTurnCalls,
    streamTextCalls,
    async runTurn(input) {
      // Shallow-copy the arrays: the loop may reuse/mutate its own message array later,
      // and assertions need what the model saw AT THIS CALL.
      runTurnCalls.push({ system: input.system, messages: [...input.messages], tools: [...input.tools] });
      const turn = queue.shift();
      if (!turn) throw new Error('scriptedLlm: runTurn called more times than scripted');
      if ('throws' in turn) throw turn.throws;
      return {
        toolCalls: turn.toolCalls ?? [],
        ...(turn.text !== undefined ? { text: turn.text } : {}),
        stopReason: turn.stopReason,
        usage: turn.usage ?? ZERO_USAGE
      };
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
