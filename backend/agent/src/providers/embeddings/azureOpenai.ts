/**
 * Azure OpenAI adapter for EmbeddingsPort. The ONLY file that may import the openai SDK for
 * embeddings; deployments are addressed by name.
 */
import { AzureOpenAI } from 'openai';
import { EMBEDDING_DIMS } from '@lumina/contract';
import { assertDims, type EmbeddingsPort } from './port.js';

export interface AzureEmbeddingsConfig {
  endpoint: string;
  apiKey: string;
  apiVersion: string;
  deployment: string;
}

export function makeAzureOpenAiEmbeddings(cfg: AzureEmbeddingsConfig): EmbeddingsPort {
  const client = new AzureOpenAI({
    endpoint: cfg.endpoint,
    apiKey: cfg.apiKey,
    apiVersion: cfg.apiVersion
  });

  return {
    async embed(texts) {
      if (texts.length === 0) return [];
      const res = await client.embeddings.create({
        model: cfg.deployment,
        input: texts,
        // text-embedding-3-large is native 3072: without this the index rejects every write.
        dimensions: EMBEDDING_DIMS
      });
      const vectors = [...res.data]
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding);
      return assertDims(vectors, EMBEDDING_DIMS);
    }
  };
}
