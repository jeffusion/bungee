import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { compile, parse } from 'svelte/compiler';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
test('OAuth owns only three shared dialog instances, not modal chrome', () => {
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
  expect(names.filter(name => name === 'IndustrialDialog')).toHaveLength(3);
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
