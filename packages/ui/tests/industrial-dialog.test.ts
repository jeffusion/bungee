import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { compile, parse } from 'svelte/compiler';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
test('shared dialog close reserves its orange focus ring for keyboard focus', () => {
  const source = read('../src/components/ui/dialog/dialog-content.svelte');
  expect(source).not.toMatch(/\bfocus:(?:ring|outline)[\w-]*/);
  for (const token of ['focus-visible:ring-nexus-500', 'focus-visible:ring-2', 'focus-visible:ring-offset-2', 'focus-visible:outline-none']) expect(source).toContain(token);
});

test('industrial close uses its own border without an outer highlight in every state', () => {
  const source = read('../src/components/industrial/IndustrialDialog.svelte');
  for (const token of [' !ring-0', ' !ring-offset-0', ' ![box-shadow:none]', ' !outline-0', 'focus:!outline-0', 'focus:border-nexus-500']) expect(source).toContain(token);
});

test('OAuth routes each modal purpose through the shared industrial dialog', () => {
  const source = read('../../../plugins/chatgpt-oauth/ui/AccountsPage.svelte');
  const names: string[] = [];
  const visit = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Component') names.push(node.name);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  visit(parse(source, { modern: true }));
  expect(names.filter(name => name === 'IndustrialDialog')).toHaveLength(4);
  const purposes = [
    ['loginOpen', 'ui.addAccount', 'ui.startLogin'],
    ['actionOpen', 'actionTitles[action]', 'accountActionFooter'],
    ['resetOpen', 'ui.resetConfirmTitle', 'credit-reset'],
    ['useOpen', 'ui.useService', 'chooseService'],
  ] as const;
  for (const [open, title, content] of purposes) {
    const start = source.indexOf(`<IndustrialDialog bind:open={${open}}`);
    const end = source.indexOf('</IndustrialDialog>', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(source.slice(start, end)).toContain(title);
    expect(source.slice(start, end)).toContain(content);
  }
  expect(names.filter(name => name.startsWith('Dialog.'))).toEqual([]);
  expect(source).not.toMatch(/nx-panel-head|nx-bracketed|role="dialog"|overflow-y-auto/);
  expect(source).toContain('form={`${id}-account-action`}');
});

test('shared dialog and live example compile for client and SSR without warnings', () => {
  for (const name of ['IndustrialDialog', 'IndustrialDialogExample']) {
    const filename = `../src/components/industrial/${name}.svelte`;
    for (const generate of ['client', 'server'] as const) {
      expect(compile(read(filename), { filename, generate }).warnings).toEqual([]);
    }
  }
  expect(read('../src/routes/DesignSystem.svelte')).toContain('<IndustrialDialogExample />');
  expect(read('../src/components/industrial/index.ts')).toContain('default as IndustrialDialog');
});

test('Select keeps supported props and SSR without a fictitious Portal', () => {
  const filename = '../src/components/ui/select/select-content.svelte';
  const source = read(filename);
  expect(source).not.toContain('SelectPrimitive.Portal');
  expect(source).toContain('{...restProps}');
  for (const generate of ['client', 'server'] as const) expect(compile(source, { filename, generate }).warnings).toEqual([]);
});
