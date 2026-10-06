import { describe, expect, test } from 'bun:test';
import { LRUCache } from '../../src/plugin-storage-cache';

const LONG_DELAY = 60_000;

function recordingCache(maxSize: number) {
  const writes: Array<{ key: string; value: unknown; ttl?: number }> = [];
  const cache = new LRUCache<string>(
    { maxSize, writeDelay: LONG_DELAY },
    async (key, value, ttl) => { writes.push({ key, value, ttl }); }
  );
  return { cache, writes };
}

describe('LRUCache clean hydration', () => {
  test('hydrate does not mark dirty or schedule a write-back', async () => {
    const { cache, writes } = recordingCache(10);
    cache.hydrate('a', 'v');
    expect(cache.get('a')).toBe('v');
    expect(cache.getStats().writes).toBe(0);
    await cache.flush();
    expect(writes).toEqual([]);
  });

  test('hydrate never clobbers a locally written dirty value', async () => {
    const { cache, writes } = recordingCache(10);
    cache.set('a', 'local');
    cache.hydrate('a', 'db-old');
    expect(cache.get('a')).toBe('local');
    await cache.flush();
    expect(writes).toEqual([{ key: 'a', value: 'local', ttl: undefined }]);
  });

  test('hydrate refreshes a clean entry without dirtying it', async () => {
    const { cache, writes } = recordingCache(10);
    cache.hydrate('a', 'one');
    cache.hydrate('a', 'two');
    expect(cache.get('a')).toBe('two');
    await cache.flush();
    expect(writes).toEqual([]);
  });

  test('evicting a clean hydrated entry does not write it back', async () => {
    const { cache, writes } = recordingCache(1);
    cache.hydrate('a', 'old');
    cache.hydrate('b', 'new');
    await cache.flush();
    expect(writes).toEqual([]);
    expect(cache.getStats().evictions).toBe(1);
  });

  test('evicting a dirty entry keeps the existing immediate write-back', async () => {
    const { cache, writes } = recordingCache(1);
    cache.set('a', 'local');
    cache.hydrate('b', 'db');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(writes).toEqual([{ key: 'a', value: 'local', ttl: undefined }]);
    await cache.flush();
  });
});
