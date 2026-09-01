import { expect, test } from 'bun:test';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import packageManifest from '../../package.json';

const packageRoot = resolve(import.meta.dir, '../..');
const dist = resolve(packageRoot, 'dist');

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

test('fresh build satisfies the published package artifact contract', async () => {
  await mkdir(resolve(dist, 'packages/core/src'), { recursive: true });
  await writeFile(resolve(dist, 'master.js'), 'stale bundle');
  await writeFile(resolve(dist, 'worker.js'), 'stale bundle');
  await writeFile(resolve(dist, 'master.d.ts'), 'stale declaration');
  await writeFile(resolve(dist, 'worker.d.ts'), 'stale declaration');
  await writeFile(resolve(dist, 'packages/core/src/stale.d.ts'), 'stale nested declaration');

  const build = Bun.spawnSync({
    cmd: [process.execPath, 'run', 'build'],
    cwd: packageRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (build.exitCode !== 0) {
    const decoder = new TextDecoder();
    throw new Error(`${decoder.decode(build.stdout)}\n${decoder.decode(build.stderr)}`);
  }

  expect(packageManifest.scripts.dev).toBe('LOG_LEVEL=debug bun --watch src/main.ts');
  expect(packageManifest.main).toBe('./dist/main.js');
  expect(Reflect.get(packageManifest, 'types')).toBe('./dist/main.d.ts');
  expect(Object.entries(packageManifest.exports)).toEqual([[
    '.', {
      types: './dist/main.d.ts',
      default: './dist/main.js',
    },
  ]]);
  expect(packageManifest.files).toEqual([
    'dist/main.js',
    'dist/main.d.ts',
    'dist/plugins',
    'README.md',
  ]);

  const packageTargets = [
    packageManifest.main,
    Reflect.get(packageManifest, 'types'),
    packageManifest.exports['.'].types,
    packageManifest.exports['.'].default,
  ];
  for (const target of packageTargets) {
    expect(typeof target).toBe('string');
    if (typeof target !== 'string') throw new TypeError('package target must be a string');
    expect(target.startsWith('./')).toBeTrue();
    expect(await exists(resolve(packageRoot, target))).toBeTrue();
  }

  for (const stale of ['master.js', 'worker.js', 'master.d.ts', 'worker.d.ts', 'packages']) {
    expect(await exists(resolve(dist, stale))).toBeFalse();
  }
  expect(await exists(resolve(dist, 'plugins'))).toBeTrue();
}, 120_000);
