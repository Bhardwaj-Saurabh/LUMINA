/**
 * When may `save_memory` be on the menu at all — ARCHITECTURE §6 (memory), TTFT work.
 *
 * Three times in the grader's 40-question thread the model saved a "fact" about the user it
 * had inferred from a QUESTION ("the user is interested in Atlas Vector Search", "the user
 * prefers concise explanations") — and, when the schema demanded an attestation that the
 * user had stated it, attested it anyway. Every later answer then paid for a recall. Prose
 * and self-attestation do not hold; what holds is the same discipline as depth and mode:
 * a tool that cannot legitimately be used is not advertised.
 *
 * A message can carry a statement about the user only if it speaks about the user — first
 * person, or an explicit instruction to remember. A bare question carries none, so on a bare
 * question there is nothing to save and the tool is simply absent.
 */
const FIRST_PERSON = /\b(i|i'm|i’m|i've|i’ve|i'd|i’d|i'll|i’ll|me|my|mine|we|we're|we’re|our|ours|us)\b/i;
const MEMORY_IMPERATIVE = /\b(remember|forget|don't forget|do not forget|from now on|going forward|call me|note that|prefer|preference)\b/i;

export function mayStateFactAboutUser(message: string): boolean {
  return FIRST_PERSON.test(message) || MEMORY_IMPERATIVE.test(message);
}
