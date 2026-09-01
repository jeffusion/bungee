import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('importing master installs no signal handlers and starts no runtime', async () => {
  const before = {
    SIGINT: process.listenerCount('SIGINT'),
    SIGTERM: process.listenerCount('SIGTERM'),
  };

  const module = await import('../../src/master');

  expect(module.startMasterProcess).toBeFunction();
  expect(process.listenerCount('SIGINT')).toBe(before.SIGINT);
  expect(process.listenerCount('SIGTERM')).toBe(before.SIGTERM);
});

test('isolated master import does not load dotenv or create logs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bungee-master-import-'));
  const marker = 'BUNGEE_IMPORT_SIDE_EFFECT_MARKER';
  const dotenvPath = join(root, 'oracle.env');
  await writeFile(dotenvPath, `${marker}=mutated\n`, 'utf8');
  const masterUrl = new URL(`file://${resolve(import.meta.dir, '../../src/master.ts')}?isolated=${crypto.randomUUID()}`);
  const script = `
    await import(${JSON.stringify(masterUrl.href)});
    const logs = await Bun.file(${JSON.stringify(join(root, 'logs'))}).exists();
    process.stdout.write(JSON.stringify({ marker: process.env[${JSON.stringify(marker)}], logs }));
  `;
  const env = { ...process.env };
  delete env[marker];
  env.DOTENV_CONFIG_PATH = dotenvPath;

  try {
    const child = Bun.spawn([process.execPath, '-e', script], {
      cwd: root,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = await new Response(child.stdout).text();
    const errors = await new Response(child.stderr).text();

    expect(await child.exited).toBe(0);
    expect(errors).toBe('');
    expect(JSON.parse(output)).toEqual({ logs: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
