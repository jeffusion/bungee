import { spawnSync } from 'node:child_process';
import { fstatSync } from 'node:fs';
import { holdInheritedProcessLifetimeGuard, PROCESS_LIFETIME_GUARD_ENV } from '../../src/supervision/process-lifetime-guard';

const instance = process.env.BUNGEE_TEST_PROCESS_INSTANCE_ID!;
if (process.argv[2] === 'check-inheritance') {
  try {
    const held = holdInheritedProcessLifetimeGuard(process.env, instance);
    process.stdout.write(JSON.stringify({ held }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: (error as Error).message }));
  }
  process.exit(0);
}
if (process.argv[2] === 'descendant') {
  const facts = JSON.parse(process.env[PROCESS_LIFETIME_GUARD_ENV]!) as { device: string; inode: string };
  let inherited = false;
  try { const stat = fstatSync(3, { bigint: true }); inherited = stat.dev.toString() === facts.device && stat.ino.toString() === facts.inode; }
  catch { /* close-on-exec removes the owned descriptor */ }
  process.stdout.write(JSON.stringify({ inherited }));
  process.exit(0);
}
const held = holdInheritedProcessLifetimeGuard(process.env, instance);
if (held === null) throw new Error('test lifetime guard was not inherited');
const descendant = spawnSync(process.execPath, [import.meta.path, 'descendant'], { encoding: 'utf8', env: process.env });
if (descendant.status !== 0) throw new Error('test descendant failed');
process.stdout.write(`${JSON.stringify({ held, descendant: JSON.parse(descendant.stdout) })}\n`);
setInterval(() => {}, 1_000);
