import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { MasterFixture, RunningMaster } from './master-real-process-harness';

export const RATE_LIMIT_TOKEN = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
export const RATE_LIMIT_PLUGIN = 'rate-limit-e2e';

const PLUGIN_MANIFEST = {
  name: RATE_LIMIT_PLUGIN,
  version: '1.0.0',
  schemaVersion: 2,
  artifactKind: 'runtime-plugin',
  main: 'index.js',
  capabilities: ['hooks', 'dynamicRuntimeLoad'],
  uiExtensionMode: 'none',
  engines: { bungee: '^4.2.0' },
  builtin: false,
  contributes: {},
  metadata: { name: 'Rate limit E2E', description: 'Rate limit E2E', icon: 'test' },
  configSchema: [],
  translations: { en: {} },
} as const;

const PLUGIN_MODULE = `
const plugin = class {
  static version = '1.0.0';
  register(hooks) {
    const worker = process.env.BUNGEE_WORKER_INSTANCE_ID || 'missing-worker-identity';
    hooks.onResponse.tapPromise({ name: 'rate-limit-e2e' }, async (response) => {
      const headers = new Headers(response.headers);
      headers.set('x-rate-limit-worker', worker);
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    });
  }
};
Object.defineProperty(plugin, 'name', { value: 'rate-limit-e2e' });
export default plugin;
`;

export async function installRateLimitFixturePlugin(fixture: MasterFixture): Promise<void> {
  const pluginPath = join(fixture.pluginsPath, RATE_LIMIT_PLUGIN);
  await mkdir(pluginPath, { recursive: true });
  await Promise.all([
    writeFile(join(pluginPath, 'manifest.json'), `${JSON.stringify(PLUGIN_MANIFEST)}\n`, 'utf8'),
    writeFile(join(pluginPath, 'index.js'), PLUGIN_MODULE, 'utf8'),
  ]);
}

export async function preserveRateLimitFailure(input: {
  readonly evidence: unknown;
  readonly first?: RunningMaster | null;
  readonly second?: RunningMaster | null;
}): Promise<void> {
  const root = join('/tmp/opencode', `rate-limit-master-real-process-${Date.now()}`);
  const redact = (value: string): string => value.replaceAll(RATE_LIMIT_TOKEN, '[REDACTED]');
  const sourceFiles = [
    resolve(import.meta.dir, '../../src/ingress/runtime.ts'),
    resolve(import.meta.dir, '../../src/rate-limit/store.ts'),
    resolve(import.meta.dir, '../../src/worker/request/handler.ts'),
  ];
  const fingerprints = await Promise.all(sourceFiles.map(async (path) => ({
    path,
    sha256: createHash('sha256').update(await readFile(path)).digest('hex'),
  })));
  await mkdir(root, { recursive: true });
  await Promise.all([
    writeFile(join(root, 'evidence.json'), redact(JSON.stringify(input.evidence, null, 2)), 'utf8'),
    writeFile(join(root, 'master-1.log'), redact(input.first?.output() ?? 'master 1 was not spawned'), 'utf8'),
    writeFile(join(root, 'master-2.log'), redact(input.second?.output() ?? 'master 2 was not spawned'), 'utf8'),
    writeFile(join(root, 'source-fingerprints.json'), JSON.stringify({
      test: 'tests/integration/rate-limit-master-real-process.test.ts',
      fixture: 'tests/fixtures/rate-limit-master-real-process.fixture.ts',
      files: fingerprints,
    }, null, 2), 'utf8'),
  ]);
}
