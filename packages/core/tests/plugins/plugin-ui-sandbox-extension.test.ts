import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPluginManifestCatalog } from '../../src/plugin-manifest-catalog';
import { createMasterUIHandler } from '../../src/ui/server';

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'bungee-master-ui-'));
  roots.push(value);
  return value;
}

function plugin(rootPath: string, name: string, mode: 'sandbox-iframe' | 'native-static' = 'sandbox-iframe'): string {
  const directory = join(rootPath, name);
  mkdirSync(join(directory, 'dist'), { recursive: true });
  mkdirSync(join(directory, 'ui'), { recursive: true });
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify({
    name,
    version: '1.0.0',
    schemaVersion: 2,
    artifactKind: 'runtime-plugin',
    main: 'dist/index.js',
    capabilities: ['hooks', 'dynamicRuntimeLoad', ...(mode === 'sandbox-iframe' ? ['sandboxUiExtension'] : ['nativeWidgetsStatic'])],
    uiExtensionMode: mode,
    engines: { bungee: '*' },
    configSchema: [],
  }));
  writeFileSync(join(directory, 'dist/index.js'), 'export default class Plugin { register() {} }');
  writeFileSync(join(directory, 'ui/index.html'), '<html>plugin</html>');
  writeFileSync(join(directory, 'ui/app.js'), 'const ready = true;');
  writeFileSync(join(directory, 'ui/style.css'), 'body {}');
  return directory;
}

function request(handler: ReturnType<typeof createMasterUIHandler>, path: string, method = 'GET'): Promise<Response | null> {
  return handler(new Request(`http://localhost/__ui${path}`, { method }));
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('Master UI handler', () => {
  test('serves bundled root, assets, and SPA fallback without workers', async () => {
    const handler = createMasterUIHandler({
      catalog: { get: () => undefined },
      getRepositorySnapshot: () => ({ aggregate: { plugin_activations: [] } } as never),
    });
    expect((await request(handler, '/'))?.headers.get('content-type')).toBe('text/html');
    expect((await request(handler, '/favicon.svg'))?.headers.get('content-type')).toBe('image/svg+xml');
    expect((await request(handler, '/routes/example'))?.headers.get('content-type')).toBe('text/html');
    expect((await request(handler, '/assets/no-such.js'))?.status).toBe(404);
    expect(await request(handler, '/api/config')).toBeNull();
    expect((await request(handler, '/apiary'))?.status).toBe(200);
    const head = await request(handler, '/favicon.svg', 'HEAD');
    expect(head?.body).toBeNull();
    expect(head?.headers.get('content-length')).toBeTruthy();
  });

  test('gates sandbox assets by a fresh activation snapshot and serves types and CSP', async () => {
    const directory = root();
    plugin(directory, 'sandbox');
    const catalog = await buildPluginManifestCatalog({ scanDirectories: [directory] });
    let active = true;
    let reads = 0;
    const handler = createMasterUIHandler({
      catalog,
      getRepositorySnapshot: () => {
        reads++;
        return { aggregate: { plugin_activations: active ? [{ plugin_name: 'sandbox' }] : [] } } as never;
      },
    });

    expect((await request(handler, '/plugins/sandbox/index.html'))?.status).toBe(200);
    expect((await request(handler, '/plugins/sandbox/app.js'))?.headers.get('content-type')).toBe('application/javascript');
    expect((await request(handler, '/plugins/sandbox/style.css'))?.headers.get('content-type')).toBe('text/css');
    expect((await request(handler, '/plugins/sandbox/index.html'))?.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(reads).toBe(4);
    active = false;
    expect((await request(handler, '/plugins/sandbox/app.js'))?.status).toBe(404);
    expect(reads).toBe(5);
    active = true;
    const head = await request(handler, '/plugins/sandbox/index.html', 'HEAD');
    expect(head?.body).toBeNull();
    expect(head?.headers.get('content-length')).toBe(String((await Bun.file(join(directory, 'sandbox', 'ui', 'index.html')).text()).length));
  });

  test('uses a repository snapshot callback and rejects native-static UI', async () => {
    const directory = root();
    plugin(directory, 'native', 'native-static');
    const catalog = await buildPluginManifestCatalog({ scanDirectories: [directory] });
    const handler = createMasterUIHandler({
      catalog,
      getRepositorySnapshot: () => ({ aggregate: { plugin_activations: [{ plugin_name: 'native' }] } } as never),
    });
    expect((await request(handler, '/plugins/native/index.html'))?.status).toBe(403);
  });

  test('fails closed for traversal, symlinks, directories, executables, and missing html', async () => {
    const directory = root();
    const pluginDirectory = plugin(directory, 'hostile');
    mkdirSync(join(pluginDirectory, 'ui', 'dir'));
    writeFileSync(join(pluginDirectory, 'ui', 'run.exe'), 'no');
    writeFileSync(join(pluginDirectory, 'secret.txt'), 'no');
    symlinkSync(join(pluginDirectory, 'secret.txt'), join(pluginDirectory, 'ui', 'link.txt'));
    const catalog = await buildPluginManifestCatalog({ scanDirectories: [directory] });
    const handler = createMasterUIHandler({
      catalog,
      getRepositorySnapshot: () => ({ aggregate: { plugin_activations: [{ plugin_name: 'hostile' }] } } as never),
    });

    const server = Bun.serve({
      port: 0,
      fetch: async (request) => await handler(request) ?? new Response('Not Found', { status: 404 }),
    });
    for (const path of [
      '/plugins/hostile/../secret.txt',
      '/plugins/hostile/%2e%2e/secret.txt',
      '/plugins/hostile/%252e%252e/secret.txt',
      '/plugins/hostile/%2Fetc/passwd',
      '/plugins/hostile/%5csecret.txt',
      '/plugins/hostile/%00.txt',
      '/plugins/hostile/dir/',
      '/plugins/hostile/link.txt',
      '/plugins/hostile/run.exe',
      '/plugins/hostile/missing.html',
      '/plugins/unknown/index.html',
    ]) {
      const curl = Bun.spawn([
        'curl', '--silent', '--show-error', '--path-as-is', '--max-time', '5',
        '--output', '/dev/null', '--write-out', '%{http_code}',
        `http://127.0.0.1:${server.port}/__ui${path}`,
      ], { stdout: 'pipe', stderr: 'pipe' });
      const status = Number(await new Response(curl.stdout).text());
      await curl.exited;
      expect(status).not.toBe(200);
    }
    await server.stop(true);
  });
});
