/**
 * search_documents — SPEC 5.4 / ARCHITECTURE.md §2.2: hybrid retrieval over the user's Space
 * becomes a ToolDef. Two properties are structural, not prompt-level:
 *   - spaceId comes from the injected request scope; the schema strips a model-supplied one.
 *   - doc sources are minted ONLY through the per-request SourceCollector, so every [n]
 *     resolves to a chunk retrieved in THIS request.
 * Not deep-only: RAG is available in the quick gear.
 */
import { z } from 'zod';
import type { RetrievedChunk } from '../rag/retrieve.js';
import type { SourceSink } from '../sourceCollector.js';
import type { ToolDef } from '../registry.js';

export function makeSearchDocumentsTool(deps: {
  /** Takes the Space as an argument so the injected value is what reaches retrieval. */
  retrieve: (query: string, spaceId: string) => Promise<RetrievedChunk[]>;
  collector: SourceSink;
  /** Request scope; never taken from the model's arguments. */
  spaceId: string;
}): ToolDef {
  const schema = z.object({
    query: z.string().min(1),
    reason: z.string().min(1)
  });
  return {
    name: 'search_documents',
    description:
      "Search the user's uploaded documents. Returns passages numbered [n]; cite those numbers in the answer.",
    schema,
    inputJsonSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for in the uploaded documents.' },
        reason: { type: 'string', description: 'One line on why the documents serve this question.' }
      },
      required: ['query', 'reason']
    },
    async execute(input: z.infer<typeof schema>) {
      // deps.spaceId, not input.spaceId — the schema has already stripped any the model sent.
      const chunks = await deps.retrieve(input.query, deps.spaceId);
      return {
        results: chunks.map((chunk) => {
          const source = deps.collector.register({
            kind: 'doc',
            docId: chunk.docId,
            title: chunk.title,
            locator: chunk.locator,
            // Verbatim: grounding checks substring the snippet, so truncation loses the anchor.
            snippet: chunk.text
          });
          return {
            citation: `[${source.n}]`,
            title: chunk.title,
            locator: chunk.locator,
            text: chunk.text
          };
        })
      };
    }
  };
}
