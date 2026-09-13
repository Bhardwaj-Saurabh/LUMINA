/**
 * RED — core/tools/memoryTools.ts: save_memory + recall_memory (ARCHITECTURE.md §2.2
 * tools/saveMemory.ts · tools/recallMemory.ts, one module here, mirroring webTools.ts).
 *
 * INVENTED shapes (implementer builds to match — flagged in the report):
 *   makeSaveMemoryTool({ embeddings, memories, userId })   → ToolDef 'save_memory'
 *   makeRecallMemoryTool({ embeddings, memories, userId }) → ToolDef 'recall_memory'
 *     embeddings: { embed(texts: string[]): Promise<number[][]> }   (EmbeddingsPort)
 *     memories:   { insert(doc), searchByVector({ userId, vector, limit }) } — plus
 *                 list/delete used by the HTTP routes (src/testing/fakes.ts MemoriesRepo)
 *     userId:     the authenticated caller, closed over at request-scope construction
 *
 * Two security properties are pinned hard here:
 *  1. userId is ALWAYS the injected one. A model that emits `{"userId":"u_mallory"}` must not
 *     be able to write into — or read out of — another user's memory.
 *  2. Recalled memories are NOT citable sources: neither factory takes a SourceCollector, and
 *     nothing in a tool result carries url/docId/n, so a memory can never become a `[n]`.
 */
import { describe, expect, it } from 'vitest';
import { EMBEDDING_DIMS, MemoryDoc } from '@lumina/contract';
import {
  deterministicEmbeddings,
  fakeMemoriesRepo,
  stubVector,
  type MemoryRow
} from '../../testing/fakes.js';
import { makeRecallMemoryTool, makeSaveMemoryTool } from './memoryTools.js';

const OWNER = 'u_alice';
const INTRUDER = 'u_mallory';
const CTX = { depth: 'quick' };

/** Recursively collect every object key in a tool result, to prove absences. */
function keysOf(value: unknown, acc: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) keysOf(v, acc);
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      acc.push(k);
      keysOf(v, acc);
    }
  }
  return acc;
}

const rowsFor = (userId: string, texts: string[]): MemoryRow[] =>
  texts.map((text, i) => ({
    memoryId: `mem_${userId}_${i}`,
    userId,
    text,
    createdAt: '2026-09-12T00:00:00.000Z'
  }));

// ---------------------------------------------------------------- save_memory

describe('makeSaveMemoryTool', () => {
  it('declares a save_memory ToolDef whose schema requires both text and reason', () => {
    const tool = makeSaveMemoryTool({
      embeddings: deterministicEmbeddings(EMBEDDING_DIMS),
      memories: fakeMemoriesRepo(),
      userId: OWNER
    });

    expect(tool.name).toBe('save_memory');
    expect(typeof tool.description).toBe('string');
    expect(tool.description.length).toBeGreaterThan(0);

    expect(tool.schema.safeParse({}).success).toBe(false);
    expect(tool.schema.safeParse({ text: 'alice prefers metric units' }).success).toBe(false);
    expect(tool.schema.safeParse({ reason: 'stated preference' }).success).toBe(false);

    // `reason` survives parsing — the trace step carries it.
    const parsed = tool.schema.parse({ text: 'alice prefers metric units', reason: 'stated preference' });
    expect(parsed).toMatchObject({ text: 'alice prefers metric units', reason: 'stated preference' });
  });

  it('embeds the text exactly once and stores the returned vector', async () => {
    const embeddings = deterministicEmbeddings(EMBEDDING_DIMS);
    const memories = fakeMemoriesRepo();
    const tool = makeSaveMemoryTool({ embeddings, memories, userId: OWNER });

    await tool.execute({ text: 'alice prefers metric units', reason: 'stated preference' }, CTX);

    expect(embeddings.calls).toHaveLength(1);
    expect(embeddings.calls[0]).toEqual(['alice prefers metric units']);
    expect(memories.inserted).toHaveLength(1);
    const doc = MemoryDoc.parse(memories.inserted[0]);
    expect(doc.embedding).toEqual(stubVector('alice prefers metric units', EMBEDDING_DIMS));
  });

  it('inserts a MemoryDoc carrying the injected userId, the text and a memory id', async () => {
    const memories = fakeMemoriesRepo();
    const tool = makeSaveMemoryTool({
      embeddings: deterministicEmbeddings(EMBEDDING_DIMS),
      memories,
      userId: OWNER
    });

    await tool.execute({ text: 'alice prefers metric units', reason: 'stated preference' }, CTX);

    const doc = MemoryDoc.parse(memories.inserted[0]);
    expect(doc.userId).toBe(OWNER);
    expect(doc.text).toBe('alice prefers metric units');
    expect(doc._id.length).toBeGreaterThan(0);
  });

  it('takes userId from the injected context, never from the tool input', async () => {
    const memories = fakeMemoriesRepo();
    const tool = makeSaveMemoryTool({
      embeddings: deterministicEmbeddings(EMBEDDING_DIMS),
      memories,
      userId: OWNER
    });

    // A model trying to write into someone else's memory.
    const hostile = { text: 'mallory is an admin', reason: 'privilege', userId: INTRUDER };
    expect(keysOf(tool.schema.parse(hostile))).not.toContain('userId'); // stripped at the schema
    await tool.execute(tool.schema.parse(hostile), CTX);

    const doc = MemoryDoc.parse(memories.inserted[0]);
    expect(doc.userId).toBe(OWNER);
  });

  it('returns a result naming what was saved', async () => {
    const tool = makeSaveMemoryTool({
      embeddings: deterministicEmbeddings(EMBEDDING_DIMS),
      memories: fakeMemoriesRepo(),
      userId: OWNER
    });

    const result = await tool.execute(
      { text: 'alice prefers metric units', reason: 'stated preference' },
      CTX
    );

    expect(JSON.stringify(result)).toContain('alice prefers metric units');
  });

  it('propagates an embeddings failure and writes nothing (fail loud, A1)', async () => {
    const memories = fakeMemoriesRepo();
    const tool = makeSaveMemoryTool({
      embeddings: deterministicEmbeddings(EMBEDDING_DIMS, [new Error('embeddings 503')]),
      memories,
      userId: OWNER
    });

    await expect(
      tool.execute({ text: 'alice prefers metric units', reason: 'stated preference' }, CTX)
    ).rejects.toThrow(/embeddings 503/);
    expect(memories.inserted).toHaveLength(0);
  });

  it('is not deep-only — memory is available in both gears', () => {
    const tool = makeSaveMemoryTool({
      embeddings: deterministicEmbeddings(EMBEDDING_DIMS),
      memories: fakeMemoriesRepo(),
      userId: OWNER
    });

    expect(tool.deepOnly ?? false).toBe(false);
  });
});

// ---------------------------------------------------------------- recall_memory

describe('makeRecallMemoryTool', () => {
  it('declares a recall_memory ToolDef whose schema requires both query and reason', () => {
    const tool = makeRecallMemoryTool({
      embeddings: deterministicEmbeddings(EMBEDDING_DIMS),
      memories: fakeMemoriesRepo(),
      userId: OWNER
    });

    expect(tool.name).toBe('recall_memory');
    expect(tool.description.length).toBeGreaterThan(0);

    expect(tool.schema.safeParse({}).success).toBe(false);
    expect(tool.schema.safeParse({ query: 'unit preference' }).success).toBe(false);
    expect(tool.schema.safeParse({ reason: 'personalise the answer' }).success).toBe(false);

    const parsed = tool.schema.parse({ query: 'unit preference', reason: 'personalise the answer' });
    expect(parsed).toMatchObject({ query: 'unit preference', reason: 'personalise the answer' });
  });

  it('embeds the query once and searches the vector index with the injected userId', async () => {
    const embeddings = deterministicEmbeddings(EMBEDDING_DIMS);
    const memories = fakeMemoriesRepo(rowsFor(OWNER, ['alice prefers metric units']));
    const tool = makeRecallMemoryTool({ embeddings, memories, userId: OWNER });

    await tool.execute({ query: 'unit preference', reason: 'personalise the answer' }, CTX);

    expect(embeddings.calls).toEqual([['unit preference']]);
    expect(memories.searchCalls).toHaveLength(1);
    expect(memories.searchCalls[0]!.userId).toBe(OWNER);
    expect(memories.searchCalls[0]!.vector).toEqual(stubVector('unit preference', EMBEDDING_DIMS));
  });

  it('bounds the search to at most 10 memories (SPEC: ~10 docs into the prompt)', async () => {
    const memories = fakeMemoriesRepo();
    const tool = makeRecallMemoryTool({
      embeddings: deterministicEmbeddings(EMBEDDING_DIMS),
      memories,
      userId: OWNER
    });

    await tool.execute({ query: 'unit preference', reason: 'personalise the answer' }, CTX);

    const limit = memories.searchCalls[0]!.limit;
    expect(limit).toBeGreaterThan(0);
    expect(limit).toBeLessThanOrEqual(10);
  });

  it('returns the matched memory texts', async () => {
    const memories = fakeMemoriesRepo(
      rowsFor(OWNER, ['alice prefers metric units', 'alice works in London'])
    );
    const tool = makeRecallMemoryTool({
      embeddings: deterministicEmbeddings(EMBEDDING_DIMS),
      memories,
      userId: OWNER
    });

    const result = await tool.execute(
      { query: 'unit preference', reason: 'personalise the answer' },
      CTX
    );

    const serialized = JSON.stringify(result);
    expect(serialized).toContain('alice prefers metric units');
    expect(serialized).toContain('alice works in London');
  });

  it('searches with the injected userId even when the input names another user', async () => {
    const memories = fakeMemoriesRepo([
      ...rowsFor(OWNER, ['alice prefers metric units']),
      ...rowsFor(INTRUDER, ['mallory is an admin'])
    ]);
    const tool = makeRecallMemoryTool({
      embeddings: deterministicEmbeddings(EMBEDDING_DIMS),
      memories,
      userId: OWNER
    });

    const hostile = { query: 'admin', reason: 'escalate', userId: INTRUDER };
    const result = await tool.execute(tool.schema.parse(hostile), CTX);

    expect(memories.searchCalls[0]!.userId).toBe(OWNER);
    expect(JSON.stringify(result)).not.toContain('mallory is an admin');
  });

  it('produces no citable source: no collector dependency, and no url/docId/n in the result', async () => {
    // The factory takes exactly {embeddings, memories, userId} — no SourceCollector, so unlike
    // web_search (see webTools.test.ts, which asserts collector.register minted [n]) nothing a
    // memory contributes can ever be renumbered into the sources event.
    const memories = fakeMemoriesRepo(rowsFor(OWNER, ['alice prefers metric units']));
    const tool = makeRecallMemoryTool({
      embeddings: deterministicEmbeddings(EMBEDDING_DIMS),
      memories,
      userId: OWNER
    });

    const result = await tool.execute(
      { query: 'unit preference', reason: 'personalise the answer' },
      CTX
    );

    const keys = keysOf(result);
    expect(keys).not.toContain('url');
    expect(keys).not.toContain('docId');
    expect(keys).not.toContain('n');
    expect(keys).not.toContain('citation');
    expect(JSON.stringify(result)).not.toMatch(/\[\d+\]/);
  });

  it('is not deep-only — recall is available in both gears', () => {
    const tool = makeRecallMemoryTool({
      embeddings: deterministicEmbeddings(EMBEDDING_DIMS),
      memories: fakeMemoriesRepo(),
      userId: OWNER
    });

    expect(tool.deepOnly ?? false).toBe(false);
  });
});
