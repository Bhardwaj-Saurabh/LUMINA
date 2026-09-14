/**
 * Azure OpenAI adapter for EmbeddingsPort. The ONLY file that may import the openai SDK for
 * embeddings; deployments are addressed by name.
 */
import { AzureOpenAI } from 'openai';
import { EMBEDDING_DIMS } from '@lumina/contract';
import { withRetry, type RetryAttempt, type RetryPolicy } from '../llm/retry.js';
import { assertDims, type EmbeddingsPort } from './port.js';

export interface AzureEmbeddingsConfig {
  endpoint: string;
  apiKey: string;
  apiVersion: string;
  deployment: string;
  /** Absent ⇒ the same bounded default as chat (providers/llm/retry.ts). */
  retry?: RetryPolicy;
  onRetry?: (info: RetryAttempt) => void;
}

const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 3, maxWaitMs: 4000 };

export function makeAzureOpenAiEmbeddings(cfg: AzureEmbeddingsConfig): EmbeddingsPort {
  const client = new AzureOpenAI({
    endpoint: cfg.endpoint,
    apiKey: cfg.apiKey,
    apiVersion: cfg.apiVersion,
    // Same reason as the chat adapter: the SDK would sleep out Azure's 30 s `Retry-After`
    // inside the call. Embeddings run BEFORE the first token (memory recall, RAG retrieval),
    // so an unbounded sleep here lands squarely in TTFT.
    maxRetries: 0
  });

  return {
    async embed(texts) {
      if (texts.length === 0) return [];
      const res = await withRetry(
        () =>
          client.embeddings.create({
            model: cfg.deployment,
            input: texts,
            // text-embedding-3-large is native 3072: without this the index rejects every write.
            dimensions: EMBEDDING_DIMS
          }),
        {
          policy: cfg.retry ?? DEFAULT_RETRY,
          ...(cfg.onRetry ? { onRetry: cfg.onRetry } : {})
        }
      );
      const vectors = [...res.data]
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding);
      return assertDims(vectors, EMBEDDING_DIMS);
    }
  };
}
