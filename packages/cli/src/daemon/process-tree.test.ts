import { expect, test } from 'bun:test';
import { captureDarwinProcessTree } from './process-tree';

const start = 'Mon Jan  1 00:00:00 2024';
const row = (pid: number, ppid: number, command: string): string => `${pid} ${ppid} 501 R ${start} ${command}`;

test('Darwin tree discovery excludes unrelated long commands from detail queries', async () => {
  const topology = [
    '10 1 Mon Jan  1 00:00:00 2024',
    '11 10 Mon Jan  1 00:00:00 2024',
    ...Array.from({ length: 100 }, (_, index) => `${1000 + index} 1 Mon Jan  1 00:00:00 2024`),
  ].join('\n');
  const detail = [
    row(10, 1, 'bun --bungee-daemon-boot=abcdef12-3456-4789-8abc-abcdef123456'),
    row(11, 10, 'bun worker.ts --bungee-process-identity=abcdef12-3456-4789-8abc-abcdef123456'),
  ].join('\n');
  const seen: string[][] = [];
  const execFile = async (file: string, args: readonly string[]) => {
    seen.push([file, ...args]);
    if (file === 'ps' && args.includes('-axo')) return { stdout: topology };
    if (file === 'ps' && args.some((arg) => arg.includes('command='))) {
      expect(args).toContain('-p');
      expect(args[args.indexOf('-p') + 1]).toBe('10,11');
      return { stdout: detail };
    }
    if (file === 'ps' && args.includes('-p')) return { stdout: '10 1 Mon Jan  1 00:00:00 2024\n11 10 Mon Jan  1 00:00:00 2024' };
    if (file === '/usr/sbin/lsof') return { stdout: `p${args[2]}\nn${process.execPath}\n` };
    throw new Error(`unexpected command ${file}`);
  };
  const snapshots = await captureDarwinProcessTree(10, { execFile: execFile as never });
  expect(snapshots.map(({ pid }) => pid)).toEqual([10, 11]);
  expect(seen.filter(([file]) => file === 'ps')).toHaveLength(3);
  expect(seen[1]).not.toContain('1000');
  expect(seen[2]).not.toContain('1000');
  expect(snapshots[1]?.ppid).toBe(10);
  expect(snapshots[1]?.rawCommand).toContain('--bungee-process-identity=abcdef12-3456-4789-8abc-abcdef123456');
});

test('Darwin tree verification rejects a changed or vanished selected PID', async () => {
  const topology = '10 1 Mon Jan  1 00:00:00 2024\n11 10 Mon Jan  1 00:00:00 2024';
  const detail = [
    row(10, 1, 'bun --bungee-daemon-boot=abcdef12-3456-4789-8abc-abcdef123456'),
    row(11, 10, 'bun worker.ts --bungee-process-identity=abcdef12-3456-4789-8abc-abcdef123456'),
  ].join('\n');
  for (const verification of [
    '10 1 Mon Jan  1 00:00:00 2024\n11 99 Mon Jan  1 00:00:00 2024',
    '10 1 Mon Jan  1 00:00:00 2024',
  ]) {
    let psCalls = 0;
    const execFile = async (file: string, args: readonly string[]) => {
      if (file !== 'ps') throw new Error('lsof must not run after topology drift');
      psCalls += 1;
      if (args.includes('-axo')) return { stdout: topology };
      if (args.some((arg) => arg.includes('command='))) return { stdout: detail };
      return { stdout: verification };
    };
    await expect(captureDarwinProcessTree(10, { execFile: execFile as never })).rejects.toThrow(/selected process tree/);
    expect(psCalls).toBe(3);
  }
});
