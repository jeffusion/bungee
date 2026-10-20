import { expect, test } from 'bun:test';

const editor = await Bun.file(new URL('../../../src/routes/RouteEditor.svelte', import.meta.url)).text();

test('route editing retains the local draft', () => {
  expect(editor).toContain("localStorage.setItem('bungee-route-draft', JSON.stringify(route))");
});

test('timeout validation returns to forwarding policy rather than request rewriting', () => {
  expect(editor).toContain("if (allErrors.some((error) => error.field.startsWith('timeouts.'))) activeSection = 'forward'");
  expect(editor).not.toContain("activeSection = 'processing';\n        return;");
});
