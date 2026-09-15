import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { normalizeText, portablePath } from '../../../tests/support/portable-text';

const WORKSPACE_ROOT = resolve(import.meta.dir, '../../..');
const GENERATED_WIDGETS_PATH = resolve(WORKSPACE_ROOT, 'packages/ui/src/components/native-widgets/generated.ts');

test('native component registry uses static imports with portable plugin paths', () => {
  const source = normalizeText(readFileSync(GENERATED_WIDGETS_PATH, 'utf8'));
  const imports = [...source.matchAll(/^import (?!type )\w+ from '([^']+)';$/gm)].map((match) => match[1]);

  expect(portablePath(relative(WORKSPACE_ROOT, GENERATED_WIDGETS_PATH)))
    .toBe('packages/ui/src/components/native-widgets/generated.ts');
  expect(imports.length).toBeGreaterThan(0);
  expect(imports.every((value) => value.startsWith('@plugins/') && !value.includes('\\'))).toBe(true);
  expect(source).not.toMatch(/\bimport\s*\(/);
});

test('Windows separators and CRLF in import fixtures normalize deterministically', () => {
  const fixture = [
    String.raw`import Demo from '@plugins/example/ui\Widget.svelte';`,
    'const label = "fixture";',
  ].join('\r\n');

  expect(portablePath(String.raw`packages\ui\tests\fixtures\Widget.svelte`))
    .toBe('packages/ui/tests/fixtures/Widget.svelte');
  expect(normalizeText(fixture)).toBe(
    "import Demo from '@plugins/example/ui\\Widget.svelte';\nconst label = \"fixture\";",
  );
});
