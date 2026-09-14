import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { parseArguments, validatePreflight } from './real-proxy';
import { startUpstream } from './real-proxy-scenarios';

describe('real proxy formal CLI', () => {
  test('accepts only the three absolute target/output options', () => {
    expect(parseArguments(['--before-root=/a', '--after-root', '/b', '--output', '/tmp/result'])).toEqual({
      beforeRoot: '/a', afterRoot: '/b', output: '/tmp/result', help: false,
    });
    expect(() => parseArguments(['--quick'])).toThrow();
    expect(() => parseArguments(['--before-root', 'relative', '--after-root', '/b', '--output', '/tmp/result'])).toThrow();
  });

  test('help is the only argument-free mode', () => {
    expect(parseArguments(['--help']).help).toBe(true);
    expect(() => parseArguments([])).toThrow();
  });

  test('preflight rejects the driver repository as a duplicate target and existing output', async () => {
    const root = resolve(import.meta.dir, '../../..');
    await expect(validatePreflight(root, root, '/tmp/unused-new-result')).rejects.toThrow('distinct');
  });

  test('large-response fixture emits one 4 MiB body, not three UTF-8 expansions', async () => {
    const upstream = await startUpstream();
    try {
      const response = await fetch(`http://127.0.0.1:${upstream.port}/a/bench?scenario=large-response`);
      const body = new Uint8Array(await response.arrayBuffer());
      expect(body.byteLength).toBe(4 * 1024 * 1024);
      expect(body[0]).toBe(0x52);
      expect(upstream.snapshot()).toMatchObject({ requests: 1, bytes: 4 * 1024 * 1024 });
    } finally {
      await upstream.server.stop(true);
    }
  });
});
