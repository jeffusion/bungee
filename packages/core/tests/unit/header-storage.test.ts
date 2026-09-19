import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { HeaderStorageManager } from '../../src/logger/header-storage';
import { makeCanonicalTempDir } from '../../../../tests/support/canonical-temp';

describe('header storage', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test('redacts reusable credentials before persistence', async () => {
    const root = makeCanonicalTempDir('bungee-header-storage');
    roots.push(root);
    const storage = new HeaderStorageManager({}, root);
    const id = await storage.save('request-1', {
      authorization: 'Bearer final-token',
      'Proxy-Authorization': 'Basic proxy-secret',
      cookie: 'session=secret',
      'Set-Cookie': 'session=secret',
      'x-request-id': 'public-value',
    }, 'original-request');

    if (id === null) throw new Error('header persistence unexpectedly failed');
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(await storage.load(id)).toEqual({ 'x-request-id': 'public-value' });
  });
});
