import { expect, test } from 'bun:test';
import { compile } from 'svelte/compiler';

const source = await Bun.file(new URL('./UpstreamForm.svelte', import.meta.url)).text();
test('modal form has no root panel or body padding; standalone form retains both', async () => {
  const root = source.match(/<div class=\{(showHeader \? 'nx-panel-raised' : '')\} data-testid="upstream-form">/)![1];
  const body = source.match(/<div class=\{(`\$\{showHeader[^\n]+`)\}>/)![1];
  const evaluate = (expression: string, showHeader: boolean) => new Function('showHeader', `return ${expression}`)(showHeader);
  expect(evaluate(root, false)).toBe('');
  expect(evaluate(body, false)).toBe('grid grid-cols-1 gap-4');
  expect(evaluate(root, true)).toBe('nx-panel-raised');
  expect(evaluate(body, true)).toBe('nx-panel-body grid grid-cols-1 gap-4');
  expect(source).toContain('showHeader = true');
  const section = await Bun.file(new URL('./sections/UpstreamsSection.svelte', import.meta.url)).text();
  expect(section).toContain('showHeader={false}');
  expect(section).toContain('nx-panel-raised nx-bracketed relative w-11/12 max-w-3xl');
  expect(() => compile(source, { filename: 'UpstreamForm.svelte' })).not.toThrow();
});

test('managed semantic card, protected binding and advanced section borders are retained', () => {
  expect(source).toContain('<PanelCard title={$_(\'upstream.managedTitle\')} tag="PLUGIN">');
  expect(source).toContain('protectedBindingIds={upstream.managedBy ? [upstream.managedBy.bindingId] : []}');
  expect(source.match(/class="border border-carbon-600 bg-carbon-950\/60"/g)?.length).toBe(3);
  for (const name of ['HeadersEditor', 'BodyEditor', 'QueryEditor']) expect(source).toContain(`<${name} bind:value={upstream.`);
});
