/**
 * Azure OpenAI adapter for LlmPort. The ONLY file that may import the openai SDK for chat.
 * Deployments are addressed by name; the /health model string is env.llmModel, which must
 * name the real deployment.
 */
import { AzureOpenAI } from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool
} from 'openai/resources/chat/completions';
import type {
  LlmMessage,
  LlmPort,
  LlmToolSpec,
  LlmUsage,
  RunTurnInput,
  RunTurnResult,
  StreamTextInput,
  TextStream
} from './port.js';

export interface AzureOpenAiConfig {
  endpoint: string;
  apiKey: string;
  apiVersion: string;
  chatDeployment: string;
}

const toOpenAiMessages = (system: string, messages: LlmMessage[]): ChatCompletionMessageParam[] => {
  const out: ChatCompletionMessageParam[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: m.content || null,
        ...(m.toolCalls && m.toolCalls.length > 0
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: 'function' as const,
                function: { name: c.name, arguments: JSON.stringify(c.input) }
              }))
            }
          : {})
      });
    } else {
      // One neutral tool_results message expands to one role:'tool' message per result.
      for (const r of m.results) {
        out.push({ role: 'tool', tool_call_id: r.toolCallId, content: r.content });
      }
    }
  }
  return out;
};

const toOpenAiTools = (tools: LlmToolSpec[]): ChatCompletionTool[] =>
  tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.inputSchema }
  }));

/** Model-authored arguments may be malformed JSON: recoverable — dispatch's zod parse rejects it. */
const parseArgs = (raw: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { __raw: raw };
  } catch {
    return { __raw: raw };
  }
};

export function makeAzureOpenAiLlm(cfg: AzureOpenAiConfig): LlmPort {
  const client = new AzureOpenAI({
    endpoint: cfg.endpoint,
    apiKey: cfg.apiKey,
    apiVersion: cfg.apiVersion
  });

  return {
    async runTurn(input: RunTurnInput): Promise<RunTurnResult> {
      const completion = await client.chat.completions.create(
        {
          model: cfg.chatDeployment,
          messages: toOpenAiMessages(input.system, input.messages),
          ...(input.tools.length > 0
            ? { tools: toOpenAiTools(input.tools), tool_choice: 'auto' as const }
            : {})
        },
        input.signal ? { signal: input.signal } : undefined
      );
      const choice = completion.choices[0];
      if (!choice) throw new Error('azure openai returned no choices');
      const toolCalls = (choice.message.tool_calls ?? [])
        .filter((c) => c.type === 'function')
        .map((c) => ({ id: c.id, name: c.function.name, input: parseArgs(c.function.arguments) }));
      return {
        toolCalls,
        text: choice.message.content ?? undefined,
        stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
        usage: { in: completion.usage?.prompt_tokens ?? 0, out: completion.usage?.completion_tokens ?? 0 }
      };
    },

    streamText(input: StreamTextInput): TextStream {
      let resolveUsage!: (u: LlmUsage) => void;
      let rejectUsage!: (e: unknown) => void;
      const usage = new Promise<LlmUsage>((res, rej) => {
        resolveUsage = res;
        rejectUsage = rej;
      });
      // Swallow nothing, but don't crash the process if usage() is never awaited after a throw.
      usage.catch(() => undefined);

      const stream = (async function* () {
        try {
          const events = await client.chat.completions.create(
            {
              model: cfg.chatDeployment,
              messages: toOpenAiMessages(input.system, input.messages),
              stream: true,
              stream_options: { include_usage: true }
            },
            input.signal ? { signal: input.signal } : undefined
          );
          let final: LlmUsage = { in: 0, out: 0 };
          for await (const chunk of events) {
            const delta = chunk.choices[0]?.delta?.content;
            if (delta) yield delta;
            if (chunk.usage) final = { in: chunk.usage.prompt_tokens, out: chunk.usage.completion_tokens };
          }
          resolveUsage(final);
        } catch (err) {
          rejectUsage(err);
          throw err; // open/mid-stream failure surfaces from the iterator (fail loud)
        }
      })();

      return { stream, usage: () => usage };
    }
  };
}
