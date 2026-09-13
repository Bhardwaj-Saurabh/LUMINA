import { describe, expect, it } from 'vitest';
import { createLru } from './lru.js';

/**
 * Bounded LRU — ARCHITECTURE.md §2.2 (`infra/lru.ts`, "bounded LRU"), the L1 tier of the
 * two-tier search cache (§2.2 `search/cached.ts`, §9 "Cache hit >= 50%").
 *
 * Pure unit: no clock, no I/O. Entry expiry is NOT the LRU's job — the cache decorator
 * stores its own `expiresAt` inside the value and enforces it on read; this module only
 * bounds memory by evicting the least recently *used* entry.
 */

describe('createLru storage', () => {
  it('returns the value a key was set with', () => {
    const lru = createLru<string>(4);
    lru.set('a', 'alpha');
    expect(lru.get('a')).toBe('alpha');
  });

  it('returns undefined for a key that was never set', () => {
    const lru = createLru<string>(4);
    lru.set('a', 'alpha');
    expect(lru.get('missing')).toBeUndefined();
  });

  it('reports membership through has without requiring the value', () => {
    const lru = createLru<string>(4);
    lru.set('a', 'alpha');
    expect(lru.has('a')).toBe(true);
    expect(lru.has('b')).toBe(false);
  });
});

describe('createLru eviction', () => {
  it('evicts the least recently used entry, so a get promotes an older key past a newer one', () => {
    const lru = createLru<string>(2);
    lru.set('a', 'alpha');
    lru.set('b', 'bravo');
    // `a` is the oldest *insertion* but now the most recently *used*.
    expect(lru.get('a')).toBe('alpha');
    lru.set('c', 'charlie');
    expect(lru.has('b')).toBe(false);
    expect(lru.get('a')).toBe('alpha');
    expect(lru.get('c')).toBe('charlie');
  });

  it('evicts the oldest insertion when nothing has been re-read', () => {
    const lru = createLru<string>(2);
    lru.set('a', 'alpha');
    lru.set('b', 'bravo');
    lru.set('c', 'charlie');
    expect(lru.has('a')).toBe(false);
    expect(lru.has('b')).toBe(true);
    expect(lru.has('c')).toBe(true);
  });

  it('never holds more entries than its capacity', () => {
    const lru = createLru<number>(3);
    for (let i = 0; i < 50; i += 1) {
      lru.set(`k${String(i)}`, i);
      expect(lru.size()).toBeLessThanOrEqual(3);
    }
    expect(lru.size()).toBe(3);
  });
});

describe('createLru overwrite', () => {
  it('updates an existing key in place without growing the cache', () => {
    const lru = createLru<string>(3);
    lru.set('a', 'alpha');
    lru.set('a', 'alpha-2');
    expect(lru.get('a')).toBe('alpha-2');
    expect(lru.size()).toBe(1);
  });

  it('does not evict a distinct key when an existing key is overwritten at capacity', () => {
    const lru = createLru<string>(2);
    lru.set('a', 'alpha');
    lru.set('b', 'bravo');
    lru.set('a', 'alpha-2');
    expect(lru.size()).toBe(2);
    expect(lru.get('b')).toBe('bravo');
    expect(lru.get('a')).toBe('alpha-2');
  });
});
