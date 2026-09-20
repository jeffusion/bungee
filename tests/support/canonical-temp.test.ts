import { describe, expect, test } from 'bun:test';
import { canonicalTempRoot, makeCanonicalTempDir } from './canonical-temp';

describe('canonical temporary test helper', () => {
  test('canonicalizes a Darwin lexical temporary path', () => {
    const fs = {
      realpathSync: (path: string) => path === '/var/folders/test/tmp' ? '/private/var/folders/test/tmp' : path,
      mkdtempSync: (prefix: string) => `${prefix}fixture`,
    };

    expect(canonicalTempRoot({ platform: 'darwin', tmpdir: () => '/var/folders/test/tmp', fs }))
      .toBe('/private/var/folders/test/tmp');
  });

  test('creates one Windows daemon-safe directory under canonical home, not /tmp/profile', () => {
    const created: string[] = [];
    const fs = {
      realpathSync: (path: string) => path,
      mkdtempSync: (prefix: string) => {
        const directory = `${prefix}fixture`;
        created.push(directory);
        return directory;
      },
    };

    expect(canonicalTempRoot({
      daemonSafe: true,
      platform: 'win32',
      tmpdir: () => 'C:\\tmp\\profile',
      homedir: () => 'C:\\Users\\alice',
      fs,
    })).toBe('C:\\Users\\alice');
    expect(created).toHaveLength(0);

    const root = canonicalTempRoot({
      daemonSafe: true,
      platform: 'win32',
      tmpdir: () => 'C:\\tmp\\profile',
      homedir: () => 'C:\\Users\\alice',
      fs,
    });

    expect(root).toBe('C:\\Users\\alice');
    const directory = makeCanonicalTempDir('fixture', {
      daemonSafe: true,
      platform: 'win32',
      tmpdir: () => 'C:\\tmp\\profile',
      homedir: () => 'C:\\Users\\alice',
      fs,
    });
    expect(directory).toBe('C:\\Users\\alice\\.bungee-daemon-safe-fixture-fixture');
    expect(directory).not.toContain('tmp\\profile');
    expect(created).toHaveLength(1);

    // Model the caller deleting the returned directory: no helper-owned outer remains.
    created.splice(created.indexOf(directory), 1);
    expect(created).toHaveLength(0);
  });

  test('rejects unsafe prefixes before touching the filesystem', () => {
    const fs = {
      realpathSync: (path: string) => path,
      mkdtempSync: () => { throw new Error('filesystem must not be touched'); },
    };

    for (const prefix of ['bad/name', 'bad\\name', 'bad\0name', '..', 'a..b']) {
      expect(() => makeCanonicalTempDir(prefix, { fs })).toThrow();
    }
  });
});
