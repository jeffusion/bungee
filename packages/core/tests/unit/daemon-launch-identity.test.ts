import { describe, expect, test } from 'bun:test';
import { parseDaemonBootMarker, resolveLaunchIdentity } from '../../src/daemon-control/launch-identity';

const BOOT = 'abcdef12-3456-7890-abcd-ef1234567890';

describe('daemon launch identity', () => {
  test('removes exactly one valid boot marker', () => {
    expect(parseDaemonBootMarker(['src/main.ts', `--bungee-daemon-boot=${BOOT}`, 'x'])).toEqual({
      bootNonce: BOOT, argv: ['src/main.ts', 'x'],
    });
  });

  test('rejects duplicate and malformed markers', () => {
    expect(() => parseDaemonBootMarker([`--bungee-daemon-boot=${BOOT}`, `--bungee-daemon-boot=${BOOT}`])).toThrow();
    expect(() => parseDaemonBootMarker(['--bungee-daemon-boot=ABC'])).toThrow();
    expect(() => parseDaemonBootMarker(['--bungee-daemon-boot'])).toThrow();
  });

  test('distinguishes compiled, direct script, and wrapper launches', () => {
    const realpath = (value: string) => value.replace('/alias/', '/real/');
    expect(resolveLaunchIdentity({ execPath: '/real/bungee', argv: ['/real/bungee', '--x'], realpath }).entrypoint).toBeNull();
    expect(resolveLaunchIdentity({ execPath: '/usr/bin/bun', argv: ['/usr/bin/bun', '/alias/src/main.ts'], realpath })).toEqual({
      executable: '/usr/bin/bun', entrypoint: '/real/src/main.ts',
    });
    expect(() => resolveLaunchIdentity({ execPath: '/usr/bin/bun', argv: ['/usr/bin/bun', 'run', 'src/main.ts'], realpath })).toThrow();
    expect(resolveLaunchIdentity({ execPath: '/opt/renamed-bun', argv: ['/opt/renamed-bun', '/alias/dist/main.js'], realpath })).toEqual({
      executable: '/opt/renamed-bun', entrypoint: '/real/dist/main.js',
    });
    expect(resolveLaunchIdentity({ execPath: '/opt/bun', argv: ['/opt/bun', '--application-arg'], realpath }).entrypoint).toBeNull();
    expect(resolveLaunchIdentity({ execPath: '/opt/bun', argv: ['/opt/bun', '/$bunfs/root/bungee'], realpath }).entrypoint).toBeNull();
  });

  test('uses Windows path semantics independently of the host platform', () => {
    expect(resolveLaunchIdentity({
      execPath: 'C:\\Tools\\BUN.EXE', argv: ['C:\\Tools\\BUN.EXE', 'C:\\App\\SRC\\MAIN.TS'],
      platform: 'win32', realpath: (value) => value,
    })).toEqual({ executable: 'C:\\Tools\\BUN.EXE', entrypoint: 'C:\\App\\SRC\\MAIN.TS' });
  });
});
