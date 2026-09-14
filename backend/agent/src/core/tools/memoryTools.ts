/**
 * save_memory + recall_memory — ARCHITECTURE.md §2.2 (tools/memoryTools.ts) and §6:
 * embed → insert / embed → userId-filtered $vectorSearch. Two properties are structural,
 * not prompt-level:
 *   - userId comes from the injected request scope; the schemas strip any model-supplied one.
 *   - neither factory takes a SourceCollector, so a recalled memory can never become a [n].
 */
import { z } from 'zod';
import { newId, type MemoryDoc } from '@lumina/contract';
import type { EmbeddingsPort } from '../../providers/embeddings/port.js';
import type { MemoriesRepo } from '../../repos/memories.js';
import type { ToolDef } from '../registry.js';

/** SPEC: ~10 recalled memories is what fits the prompt budget. */
const RECALL_LIMIT = 10;

export function makeSaveMemoryTool(deps: {
  embeddings: EmbeddingsPort;
  memories: Pick<MemoriesRepo, 'insert'>;
  userId: string;
  /** Traceability: where the memory came from (MemoryDoc.sourceThread). */
  threadId?: string;
  now?: () => number;
}): ToolDef {
  const now = deps.now ?? Date.now;
  // The attestation is structural, not prose: twice in the grader's 40-question thread the
  // model saved an "interest" it had inferred from a QUESTION, which then charged every later
  // answer a recall. A literal `true` the model must set explicitly turns "did the user
  // actually say this?" into a validation failure instead of a polluted memory.
  const schema = z.object({
    text: z.string().min(1),
    reason: z.string().min(1),
    statedByUser: z.literal(true)
  });
  return {
    name: 'save_memory',
    description:
      'Remember something the user EXPLICITLY STATED about themselves — a preference, a ' +
      'constraint, an ongoing project, who they are — so future threads can honour it. Never ' +
      'infer an interest from the questions they ask: asking about Atlas Vector Search is not ' +
      'a fact about the user, and saving it pollutes every later answer with a spurious recall.',
    schema,
    inputJsonSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The fact to remember, as one self-contained sentence.' },
        reason: { type: 'string', description: 'One line on why this is worth remembering.' },
        statedByUser: {
          type: 'boolean',
          enum: [true],
          description:
            'Must be true, and only set it when the user themselves stated this fact in their ' +
            'own words (a preference, a constraint, who they are, what they are working on). ' +
            'Something you inferred from a question they asked is NOT stated by the user — do ' +
            'not call this tool for it.'
        }
      },
      required: ['text', 'reason', 'statedByUser']
    },
    async execute(input: z.infer<typeof schema>) {
      const [embedding] = await deps.embeddings.embed([input.text]);
      if (!embedding) throw new Error('save_memory: embeddings returned no vector');
      const doc: MemoryDoc = {
        _id: newId('mem'),
        userId: deps.userId,
        text: input.text,
        embedding,
        ...(deps.threadId ? { sourceThread: deps.threadId } : {}),
        createdAt: new Date(now()).toISOString()
      };
      await deps.memories.insert(doc);
      return { saved: input.text };
    }
  };
}

export function makeRecallMemoryTool(deps: {
  embeddings: EmbeddingsPort;
  memories: Pick<MemoriesRepo, 'searchByVector'>;
  userId: string;
}): ToolDef {
  const schema = z.object({
    query: z.string().min(1),
    reason: z.string().min(1)
  });
  return {
    name: 'recall_memory',
    description:
      'Recall what this user has told you before (preferences, stable facts). Not a citable ' +
      'source. Call it IN THE SAME TURN as your search, never on its own: a turn that only ' +
      'recalls still has to search afterwards, which costs the user a whole extra round trip.',
    schema,
    inputJsonSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for in the user long-term memory.' },
        reason: { type: 'string', description: 'One line on why recall helps this question.' }
      },
      required: ['query', 'reason']
    },
    async execute(input: z.infer<typeof schema>) {
      const [vector] = await deps.embeddings.embed([input.query]);
      if (!vector) throw new Error('recall_memory: embeddings returned no vector');
      const matches = await deps.memories.searchByVector({
        userId: deps.userId,
        vector,
        limit: RECALL_LIMIT
      });
      return { memories: matches.map((m) => ({ text: m.text })) };
    }
  };
}
