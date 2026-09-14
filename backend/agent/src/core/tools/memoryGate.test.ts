/**
 * RED — when may `save_memory` be on the menu at all?
 *
 * Measured three times in the grader's 40-question thread: shown save_memory on a plain
 * question ("What is MongoDB Atlas Vector Search used for?"), the model saved "the user is
 * interested in Atlas Vector Search" — and, when the schema demanded an attestation that the
 * user had stated it, attested it anyway. Prose and self-attestation do not hold. What holds
 * is not offering the tool when the message cannot contain a statement about the user:
 * a question is not a fact about the user, so on a question there is nothing to save.
 */
import { describe, expect, it } from 'vitest';
import { mayStateFactAboutUser } from './memoryGate.js';

describe('mayStateFactAboutUser', () => {
  it('is true for the grader memory probe and for ordinary first-person statements', () => {
    for (const q of [
      'Remember this preference for all future answers: Always answer in British English and keep answers under 100 words.',
      'I prefer code examples over prose.',
      "I'm working on a RAG system in TypeScript.",
      'My team uses MongoDB Atlas.',
      'We always deploy to europe-west2.',
      'Please remember that I am allergic to verbose answers.',
      'From now on, keep it under 50 words.',
      'Call me Saurabh.'
    ]) {
      expect(mayStateFactAboutUser(q), q).toBe(true);
    }
  });

  it('is false for plain questions, including the ones that got memories saved from them', () => {
    for (const q of [
      'What is MongoDB Atlas Vector Search used for?',
      'What does reciprocal rank fusion do?',
      'Who maintains the Tavily search API?',
      'How do Server-Sent Events differ from WebSockets?',
      'Why does BM25 fail on a query for car when the document says automobile?',
      'Explain hybrid search.'
    ]) {
      expect(mayStateFactAboutUser(q), q).toBe(false);
    }
  });

  it('is true when a question is combined with a statement about the user', () => {
    expect(mayStateFactAboutUser('I use Python — what is RRF?')).toBe(true);
    expect(mayStateFactAboutUser("What's RRF? Remember I hate jargon.")).toBe(true);
  });
});
