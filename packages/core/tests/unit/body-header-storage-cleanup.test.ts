import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BodyStorageManager } from '../../src/logger/body-storage';
import { HeaderStorageManager } from '../../src/logger/header-storage';
import { makeCanonicalTempDir } from '../../../../tests/support/canonical-temp';

const oldDate = '2000-01-01';

describe('body and header cleanup containment', () => {
  const roots: string[] = [];

  function root(name: string): string {
    const value = makeCanonicalTempDir(`bungee-${name}`);
    roots.push(value);
    return value;
  }

  afterEach(() => {
    for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
  });

  test('removes only real, canonical date directories', async () => {
    for (const create of [
      (directory: string) => new BodyStorageManager({}, directory),
      (directory: string) => new HeaderStorageManager({}, directory),
    ]) {
      const directory = root('cleanup-real');
      const dateDirectory = join(directory, oldDate);
      mkdirSync(dateDirectory);
      writeFileSync(join(dateDirectory, 'entry'), 'entry');

      const result = await create(directory).cleanup();

      expect(result.deletedDirs).toBe(1);
      expect(result.deletedFiles).toBe(1);
      expect(await Bun.file(join(dateDirectory, 'entry')).exists()).toBe(false);
    }
  });

  test('skips symlink roots and in/out-of-root date entries', async () => {
    for (const create of [
      (directory: string) => new BodyStorageManager({}, directory),
      (directory: string) => new HeaderStorageManager({}, directory),
    ]) {
      const actualRoot = root('cleanup-root');
      const outside = root('cleanup-outside');
      const inside = join(actualRoot, 'inside');
      mkdirSync(inside);
      mkdirSync(join(outside, oldDate));
      mkdirSync(join(inside, oldDate));
      writeFileSync(join(outside, oldDate, 'outside-entry'), 'outside');
      writeFileSync(join(inside, oldDate, 'inside-entry'), 'inside');

      const rootLink = join(root('cleanup-link'), 'root');
      symlinkSync(actualRoot, rootLink, 'dir');
      const rootResult = await create(rootLink).cleanup();
      expect(rootResult.deletedDirs).toBe(0);
      expect(await Bun.file(join(actualRoot, 'inside', oldDate, 'inside-entry')).exists()).toBe(true);

      const entryRoot = root('cleanup-entry');
      const outsideLink = join(entryRoot, `${oldDate}`);
      const insideLink = join(entryRoot, '2000-01-02');
      symlinkSync(join(outside, oldDate), outsideLink, 'dir');
      symlinkSync(join(inside, oldDate), insideLink, 'dir');
      const entryResult = await create(entryRoot).cleanup();
      expect(entryResult.deletedDirs).toBe(0);
      expect(await Bun.file(join(outside, oldDate, 'outside-entry')).exists()).toBe(true);
      expect(await Bun.file(join(inside, oldDate, 'inside-entry')).exists()).toBe(true);
    }
  });

  test('documents the TOCTOU boundary without claiming to remove the OS race', async () => {
    const directory = root('cleanup-toctou');
    const dateDirectory = join(directory, oldDate);
    mkdirSync(dateDirectory);
    writeFileSync(join(dateDirectory, 'entry'), 'entry');

    // lstat + realpath rejects the hostile state observed by this test. A concurrent
    // replacement between verification and rmSync remains an OS-level TOCTOU threat.
    symlinkSync(directory, join(directory, 'not-a-date-link'), 'dir');
    const result = await new BodyStorageManager({}, directory).cleanup();

    expect(result.deletedDirs).toBe(1);
    expect(await Bun.file(join(dateDirectory, 'entry')).exists()).toBe(false);
  });
});
