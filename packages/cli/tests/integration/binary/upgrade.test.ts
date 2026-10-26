import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertNoUpdate, selectedVersion } from '../../../../core/src/updates/installation';

for (const signal of ['SIGINT', 'SIGTERM'] as const) test(`offline upgrade ${signal} cancels and releases ownership without starting`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'bungee-upgrade-signal-'));
  writeFileSync(join(root, 'version.txt'), '6.6.0\n');
  const fixture = join(root, 'upgrade-fixture.mjs');
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, '../../fixtures/upgrade-signal.ts')],
    target: 'node', outdir: root, naming: 'upgrade-fixture.mjs' });
  if (!build.success) throw new Error(build.logs.join('\n'));
  const child = Bun.spawn(['node', fixture], {
    env: { ...process.env, BUNGEE_INSTALL_ROOT: root }, stdout: 'pipe', stderr: 'pipe',
  });
  try {
    const reader = child.stdout.getReader();
    let output = '';
    while (!output.includes('archive-requested')) {
      const next = await reader.read();
      if (next.done) throw new Error(`Upgrade did not request its archive: ${output} ${await new Response(child.stderr).text()}`);
      output += new TextDecoder().decode(next.value);
    }
    reader.releaseLock();
    expect(existsSync(join(root, 'update.lock'))).toBe(true);
    child.kill(signal);
    expect(await child.exited).toBe(1);
    expect(JSON.parse(readFileSync(join(root, 'update.json'), 'utf8'))).toMatchObject({ phase: 'cancelled', error: 'update_cancelled' });
    expect(selectedVersion(root)).toBe('6.6.0');
    expect(existsSync(join(root, 'run', 'daemon.json'))).toBe(false);
    expect(() => assertNoUpdate(root)).not.toThrow();
  } finally {
    if (child.exitCode === null) { child.kill('SIGTERM'); await child.exited; }
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);
