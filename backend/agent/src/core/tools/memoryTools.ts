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
  const schema = z.object({
    text: z.string().min(1),
    reason: z.string().min(1)
  });
  return {
    name: 'save_memory',
    description:
      'Remember a durable fact or preference the user stated about themselves, for future threads.',
    schema,
    inputJsonSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The fact to remember, as one self-contained sentence.' },
        reason: { type: 'string', description: 'One line on why this is worth remembering.' }
      },
      required: ['text', 'reason']
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
      'Recall what this user has told you before (preferences, stable facts). Not a citable source.',
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
