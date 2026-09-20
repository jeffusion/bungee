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

function makeDarwinTreeExec(lsofOutput: string, expectedExecutable?: string, paths: Readonly<Record<string, string>> = {}) {
  const topology = '10 1 Mon Jan  1 00:00:00 2024';
  const detail = row(10, 1, 'bun --bungee-daemon-boot=abcdef12-3456-4789-8abc-abcdef123456');
  return async (file: string, args: readonly string[]) => {
    if (file === 'ps' && args.includes('-axo')) return { stdout: topology };
    if (file === 'ps' && args.some((arg) => arg.includes('command='))) return { stdout: detail };
    if (file === 'ps' && args.includes('-p')) return { stdout: topology };
    if (file === '/usr/sbin/lsof') return { stdout: lsofOutput };
    throw new Error(`unexpected command ${file} ${expectedExecutable ?? ''}`);
  };
}

test('Darwin expected executable accepts one canonical main txt among dyld and cache entries', async () => {
  const expected = '/Applications/Bun/bin/bun';
  const canonical = '/private/real/bun';
  const paths: Record<string, string> = {
    [expected]: canonical,
    '/usr/lib/dyld': '/usr/lib/dyld', '/tmp/cache': '/tmp/cache',
  };
  const realpath = async (path: string) => paths[path] ?? path;
  const snapshots = await captureDarwinProcessTree(10, {
    expectedExecutable: expected,
    execFile: makeDarwinTreeExec('p10\nn/Applications/Bun/bin/bun\nn/usr/lib/dyld\nn/tmp/cache\n') as never,
    realpath: realpath as never,
  });
  expect(snapshots[0]?.executable).toBe(canonical);
});

test('Darwin expected executable fails closed on zero match and generic multi-txt output', async () => {
  const expected = '/Applications/Bun/bin/bun';
  const paths: Record<string, string> = { [expected]: '/real/bun', '/usr/bin/other': '/real/other', '/tmp/cache': '/real/cache' };
  await expect(captureDarwinProcessTree(10, {
    expectedExecutable: expected,
    execFile: makeDarwinTreeExec('p10\nn/usr/bin/other\n') as never,
    realpath: (async (path: string) => paths[path] ?? path) as never,
  })).rejects.toThrow(/darwin executable identity/);
  await expect(captureDarwinProcessTree(10, {
    execFile: makeDarwinTreeExec('p10\nn/usr/bin/other\nn/tmp/cache\n') as never,
    realpath: (async (path: string) => paths[path] ?? path) as never,
  })).rejects.toThrow(/darwin executable identity/);
});

test('Darwin expected executable accepts aliases resolving to one canonical path while generic mode rejects ambiguity', async () => {
  const expected = '/Applications/Bun/bin/bun';
  const aliases = ['/Applications/Bun/bin/bun', '/private/alias/bun'];
  const realpath = async (path: string) => aliases.includes(path) || path === expected ? '/real/bun' : path;
  await expect(captureDarwinProcessTree(10, {
    expectedExecutable: expected,
    execFile: makeDarwinTreeExec(`p10\nn${aliases[0]}\nn${aliases[1]}\n`) as never, realpath: realpath as never,
  })).resolves.toHaveLength(1);
  await expect(captureDarwinProcessTree(10, {
    execFile: makeDarwinTreeExec('p10\nn/Applications/Bun/bin/bun\nn/private/other/bun\n') as never,
    realpath: (async (path: string) => path === expected || path.endsWith('/bun') ? `/real/${path.includes('other') ? 'other' : 'bun'}` : path) as never,
  })).rejects.toThrow(/darwin executable identity/);
});
