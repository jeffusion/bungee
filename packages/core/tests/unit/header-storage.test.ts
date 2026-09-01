import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HeaderStorageManager } from '../../src/logger/header-storage';

describe('header storage', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test('redacts reusable credentials before persistence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bungee-header-storage-'));
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
    expect(await storage.load(id)).toEqual({ 'x-request-id': 'public-value' });
  });
});
