/**
 * LlmPort — the neutral turn-based contract the loop consumes (ARCHITECTURE.md §2.2:
 * this directory is the only place SDK imports may live; the port itself is types only).
 *
 * Deliberately provider-agnostic: `toolCalls` + `stopReason: 'tool_use' | 'end_turn'` map
 * 1:1 onto both Azure OpenAI `tool_calls`/`finish_reason` and Anthropic
 * `tool_use`/`stop_reason`, and the single `tool_results` message role maps onto
 * Anthropic's user-message tool_result blocks and Azure's role:'tool' messages alike.
 */

/** One tool invocation the model asked for in a turn. */
export interface ToolCallRequest {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** One tool outcome handed back to the model. `ok:false` carries the error text in `content`. */
export interface ToolResultPart {
  toolCallId: string;
  ok: boolean;
  content: string;
}

/**
 * Neutral conversation message. ALL tool results of one research step travel in ONE
 * `tool_results` message.
 */
export type LlmMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCallRequest[] }
  | { role: 'tool_results'; results: ToolResultPart[] };

/** Provider-neutral tool advertisement (JSON-schema payload derived from the zod schema). */
export interface LlmToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LlmUsage {
  in: number;
  out: number;
}

/**
 * Whether the turn MAY call a tool or MUST. `required` is how "every answer is grounded"
 * becomes a property of the request rather than a line in the prompt — with optimistic
 * streaming the first text delta is already sent, so there is no later point at which an
 * ungrounded answer could be caught.
 */
export type LlmToolChoice = 'auto' | 'required';

export interface RunTurnInput {
  system: string;
  messages: LlmMessage[];
  tools: LlmToolSpec[];
  /** Defaults to 'auto'. Meaningless — and never sent — when `tools` is empty. */
  toolChoice?: LlmToolChoice;
  /** Deadline propagation (§3.1): a hung provider call must not outlive the request budget. */
  signal?: AbortSignal;
}

export interface RunTurnResult {
  toolCalls: ToolCallRequest[];
  text?: string;
  stopReason: 'tool_use' | 'end_turn';
  usage: LlmUsage;
}

/**
 * ONE turn, streamed: assistant text deltas as they arrive, plus the completed turn.
 *
 *   stream    the turn's text deltas, IF it answers rather than calling tools.
 *             A research turn yields nothing.
 *   result()  Resolves only after the stream is drained — a real provider sends
 *             stop_reason/usage last, so the loop must iterate before it can decide.
 */
export interface TurnStream {
  stream: AsyncIterable<string>;
  result(): Promise<RunTurnResult>;
}

export interface LlmPort {
  /** Non-streaming turn, for structured one-shot calls (e.g. the deep planner). */
  runTurn(input: RunTurnInput): Promise<RunTurnResult>;
  /** The loop's turn primitive: research and the answer both arrive through this. */
  streamTurn(input: RunTurnInput): TurnStream;
}
