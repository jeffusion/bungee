import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { globalStyleFingerprints, isOrderedStyleSubset, stylesheetImports, templateStylesheetElements } from '../../../tests/support/ui-style-policy';
import baseline from '../docs/global-style-baseline.json';

const workspace = resolve(import.meta.dir, '../../..');
const roots = [resolve(workspace, 'packages/ui/src'), ...readdirSync(resolve(workspace, 'plugins'), { withFileTypes: true })
  .filter(entry => entry.isDirectory()).map(entry => resolve(workspace, 'plugins', entry.name, 'ui'))];
const styles = /\.(css|scss|sass|less|styl)$/;
function files(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const file = resolve(directory, entry.name);
      return entry.isDirectory() ? files(file) : /\.(svelte|[cm]?[jt]s|css|scss|sass|less|styl)$/.test(file) && !/\.test\.[^.]+$/.test(file) ? [file] : [];
    });
  } catch (error: any) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

test('UI and all plugin UI global styles and stylesheet imports stay within the frozen baseline', () => {
  for (const file of roots.flatMap(files)) {
    const name = relative(workspace, file).replaceAll('\\', '/');
    const source = readFileSync(file, 'utf8');
    expect(source, `${name}: global/external style attributes are forbidden`).not.toMatch(/<style\b[^>]*\b(?:global|src)\s*(?:=|>)/);
    if (file.endsWith('.svelte')) {
      expect(templateStylesheetElements(source), `${name}: template/head global style elements are forbidden`).toEqual([]);
    }
    if (file.endsWith('.svelte') || styles.test(file)) {
      const actual = globalStyleFingerprints(source, file.endsWith('.svelte'));
      const entry = baseline.styles[name as keyof typeof baseline.styles];
      expect(isOrderedStyleSubset(actual, entry?.fingerprints ?? []),
        `${name}: unregistered/changed/reordered global CSS; use a scoped component or follow INDUSTRIAL_DESIGN_SYSTEM.md §3.4.7`).toBe(true);
    }
    for (const specifier of stylesheetImports(source)) {
      expect(baseline.imports, `${name}: unregistered global stylesheet import ${specifier}`)
        .toContainEqual({ file: name, specifier });
    }
  }
  for (const entry of Object.values(baseline.styles)) expect(entry.reason.length).toBeGreaterThan(0);
});

test('global-style detection covers selector/block forms, rule changes, media scope and imports', () => {
  const component = (css: string) => `<div></div><style>${css}</style>`;
  expect(globalStyleFingerprints(component('.local { color: red }'), true)).toEqual([]);
  for (const css of [':global(button) { color: red }', ':global { button { color: red } }', '.local :global(button) { color: red }', '@import "external.css";', '@keyframes -global-flash { from { opacity: 0 } }', '@font-face { font-family: leaked; src: url(font.woff2) }']) {
    expect(globalStyleFingerprints(component(css), true)).toHaveLength(1);
  }
  const original = globalStyleFingerprints(component(':global(button) { color: red }'), true);
  expect(globalStyleFingerprints(component(':global(button) { color: blue }'), true)).not.toEqual(original);
  expect(globalStyleFingerprints(component('@media (min-width: 10px) { :global(button) { color: red } }'), true)).not.toEqual(original);
  expect(globalStyleFingerprints('button { color: red }', false)).not.toEqual(globalStyleFingerprints('button, input { color: red }', false));
  expect(stylesheetImports('import "x.css"; import style from "y.scss?inline"; import("z.css");')).toEqual(['x.css', 'y.scss?inline', 'z.css']);
});

test('template/head style elements and stylesheet links cannot bypass scoped-style policy', () => {
  expect(templateStylesheetElements('<div></div><style>div { color: red }</style>')).toEqual([]);
  for (const source of ['<svelte:head><style>button { color: red }</style></svelte:head>',
    '<svelte:head><link rel="stylesheet" href="https://example.com/theme.css" /></svelte:head>',
    '<svelte:head><link rel={kind} href={url} /></svelte:head>',
    '{#if visible}<div><style>button { color: red }</style></div>{/if}']) {
    expect(templateStylesheetElements(source)).toHaveLength(1);
  }
  expect(templateStylesheetElements('<svelte:head><link rel="icon" href="icon.svg" /></svelte:head>')).toEqual([]);
});

test('frozen rules allow removal but reject reorder that changes the cascade', () => {
  const component = (css: string) => `<div></div><style>${css}</style>`;
  const first = ':global(.button:hover) { border-color: red }';
  const second = ':global(.button.active) { border-color: blue }';
  const original = globalStyleFingerprints(component(first + second), true);
  const swapped = globalStyleFingerprints(component(second + first), true);
  expect(swapped).not.toEqual(original);
  expect(isOrderedStyleSubset(swapped, original)).toBe(false);
  expect(isOrderedStyleSubset(globalStyleFingerprints(component(second), true), original)).toBe(true);
  expect(isOrderedStyleSubset([], original)).toBe(true);
  expect(isOrderedStyleSubset([...original, ...original], original)).toBe(false);
});
