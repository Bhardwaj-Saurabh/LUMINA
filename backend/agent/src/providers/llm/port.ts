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

export interface RunTurnInput {
  system: string;
  messages: LlmMessage[];
  tools: LlmToolSpec[];
}

export interface RunTurnResult {
  toolCalls: ToolCallRequest[];
  text?: string;
  stopReason: 'tool_use' | 'end_turn';
  usage: LlmUsage;
}

export interface StreamTextInput {
  system: string;
  messages: LlmMessage[];
}

/**
 * Chosen streaming shape: `streamText` returns synchronously with a lazy delta stream plus
 * `usage()` resolving after the stream is drained. A real adapter opens the connection on
 * first iteration; open-failure surfaces as a throw from the iterator.
 */
export interface TextStream {
  stream: AsyncIterable<string>;
  usage(): Promise<LlmUsage>;
}

export interface LlmPort {
  runTurn(input: RunTurnInput): Promise<RunTurnResult>;
  streamText(input: StreamTextInput): TextStream;
}
