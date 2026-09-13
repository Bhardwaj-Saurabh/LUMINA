/**
 * Bounded LRU (ARCHITECTURE §2.2) — the L1 tier of the search cache. Memory bound only:
 * entry expiry belongs to the cache decorator, which keeps its own `expiresAt` in the value.
 */

export interface Lru<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  has(key: string): boolean;
  size(): number;
}

export function createLru<T>(maxEntries: number): Lru<T> {
  // Map iterates in insertion order, so delete + re-set moves a key to the newest position
  // and the first key is always the least recently used one.
  const entries = new Map<string, T>();

  return {
    get(key) {
      if (!entries.has(key)) return undefined;
      const value = entries.get(key) as T;
      entries.delete(key);
      entries.set(key, value);
      return value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, value);
      if (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (!oldest.done) entries.delete(oldest.value);
      }
    },
    has: (key) => entries.has(key),
    size: () => entries.size
  };
}
