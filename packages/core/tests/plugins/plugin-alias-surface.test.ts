import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { normalizeText, portablePath } from '../../../../tests/support/portable-text';

const WORKSPACE_ROOT = resolve(import.meta.dir, '../../../..');
const ARTIFACT_LOADER_PATH = resolve(WORKSPACE_ROOT, 'packages/core/src/plugin-control/artifact-loader.ts');

test('control artifact loader tracks require aliases and rejects unlocked loads', () => {
  const source = normalizeText(readFileSync(ARTIFACT_LOADER_PATH, 'utf8'));

  expect(portablePath(relative(WORKSPACE_ROOT, ARTIFACT_LOADER_PATH)))
    .toBe('packages/core/src/plugin-control/artifact-loader.ts');
  expect(source).toContain("const aliases = new Set<string>(['require']);");
  expect(source).toContain('aliases.has(initializer.text)');
  expect(source).toContain('isRequireAlias');
  expect(source).toContain('isRequireProperty');
  expect(source).toContain('isStaticSpecifier(node.arguments[0])');
});

test('Windows separators and CRLF in alias fixtures normalize deterministically', () => {
  const fixture = [
    'const load = require;',
    String.raw`load('.\helper.cjs');`,
  ].join('\r\n');

  expect(portablePath(String.raw`packages\core\src\plugin-control\artifact-loader.ts`))
    .toBe('packages/core/src/plugin-control/artifact-loader.ts');
  expect(normalizeText(fixture)).toBe("const load = require;\nload('.\\helper.cjs');");
});
