import { describe, expect, test } from 'bun:test';
import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { startUiRuntime } from '../../helpers/ui-runtime';

const request = (origin: string, path = '/', init?: RequestInit) => fetch(origin + path, {
  ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), Connection: 'close' },
});
const removed = async (path: string) => { await expect(access(path)).rejects.toThrow(); };

describe('owned UI test runtimes', () => {
  test('built pages serve the current build, MIME types and SPA routes while missing assets stay 404', async () => {
    const runtime = await startUiRuntime({ mode: 'built-page' });
    try {
      expect(Object.keys(runtime).sort()).toEqual(['close', 'evidence', 'origin']);
      const index = await request(runtime.origin);
      expect(index.status).toBe(200);
      expect(index.headers.get('content-type')).toContain('text/html');
      const html = await index.text();
      const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?]+)"/g)].map(match => match[1]!);
      expect(assets.some(asset => asset.endsWith('.js'))).toBe(true);
      expect(assets.some(asset => asset.endsWith('.css'))).toBe(true);
      for (const path of assets) {
        const response = await request(runtime.origin, path);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain(path.endsWith('.css') ? 'text/css' : 'javascript');
        expect((await response.text()).length).toBeGreaterThan(0);
      }
      const spa = await request(runtime.origin, '/configuration', { headers: { accept: 'text/html' } });
      expect(await spa.text()).toBe(html);
      const head = await request(runtime.origin, '/', { method: 'HEAD' });
      expect(head.status).toBe(200); expect(await head.text()).toBe('');
      for (const path of ['/assets/missing.js', '/assets/missing.css', '/missing.svg', '/api/missing', '/tests/fixtures/missing', '/src/missing']) {
        expect((await request(runtime.origin, path, { headers: { accept: 'text/html' } })).status).toBe(404);
      }
      expect((await request(runtime.origin, '/', { method: 'POST' })).status).toBe(405);
      expect((await request(runtime.origin, '/%E0%A4%A')).status).toBe(400);
      expect((await request(runtime.origin, '/%2e%2e%2fpackage.json')).status).toBe(404);
    } finally { await runtime.close(); }
    await runtime.close(); await removed(runtime.evidence);
  });

  test('closing one built runtime releases only its own port and temporary files', async () => {
    const first = await startUiRuntime({ mode: 'built-page' });
    const second = await startUiRuntime({ mode: 'built-page' });
    try {
      expect(first.origin).not.toBe(second.origin); expect(first.evidence).not.toBe(second.evidence);
      await first.close(); await removed(first.evidence);
      await expect(request(first.origin)).rejects.toThrow();
      expect((await request(second.origin)).status).toBe(200);
      await access(second.evidence);
    } finally { try { await first.close(); } finally { await second.close(); } }
    await removed(second.evidence);
  });

  test('a missing build fails before listening and cleans up its owned temporary directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bungee-ui-missing-build-'));
    const before = (await readdir(tmpdir())).filter(name => name.startsWith('bungee-ui-test-')).sort();
    try {
      await expect(startUiRuntime({ mode: 'built-page', buildDirectory: directory })).rejects.toThrow('Missing UI build');
      expect((await readdir(tmpdir())).filter(name => name.startsWith('bungee-ui-test-')).sort()).toEqual(before);
      // The caller owns this directory; helper failure must leave it intact.
      await writeFile(join(directory, 'owned-by-caller'), 'keep');
      await access(join(directory, 'owned-by-caller'));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test('component fixtures retain Vite transforms and aliases, then release their port, cache and cwd', async () => {
    const previousDirectory = process.cwd();
    const runtime = await startUiRuntime({ mode: 'component-fixture', entries: ['tests/fixtures/components/lazy/index.html'], aliases: [
      { find: '$i18n', replacement: resolve(import.meta.dir, '../../../packages/ui/tests/fixtures/components/lazy/i18n.js') },
      { find: '$components/industrial/LoadingIndicator.svelte', replacement: resolve(import.meta.dir, '../../../packages/ui/tests/fixtures/components/lazy/loading.svelte') },
    ] });
    try {
      expect(Object.keys(runtime).sort()).toEqual(['close', 'evidence', 'origin']);
      expect((await request(runtime.origin, '/tests/fixtures/components/lazy/index.html')).status).toBe(200);
      const transformed = await request(runtime.origin, '/src/components/shell/LazyPage.svelte');
      expect(transformed.status).toBe(200);
      const source = await transformed.text();
      expect(source).toContain('/tests/fixtures/components/lazy/i18n.js');
      expect(source).toContain('/tests/fixtures/components/lazy/loading.svelte');
      const dependency = source.match(/"([^"\n]*\/deps\/[^"\n]+)"/)?.[1];
      expect(dependency).toBeDefined();
      expect((await request(runtime.origin, dependency!)).status).toBe(200);
      await access(join(runtime.evidence, 'cache'));
    } finally { await runtime.close(); }
    expect(process.cwd()).toBe(previousDirectory);
    await expect(request(runtime.origin)).rejects.toThrow();
    await removed(runtime.evidence);
  }, 60_000);

  test('a fixture closed before navigation finishes its dependency scan before removing its cache', async () => {
    const previousDirectory = process.cwd();
    const runtime = await startUiRuntime({ mode: 'component-fixture', entries: ['tests/fixtures/number-input.html'] });
    try { await runtime.close(); } finally { await runtime.close(); }
    expect(process.cwd()).toBe(previousDirectory);
    await removed(runtime.evidence);
    await expect(request(runtime.origin)).rejects.toThrow();
  }, 60_000);
});
