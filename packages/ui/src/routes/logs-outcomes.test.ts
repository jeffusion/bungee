import { expect, test } from 'bun:test';
import { compile } from 'svelte/compiler';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const directory = import.meta.dir;
const source = await Bun.file(`${directory}/Logs.svelte`).text();
const modules: Record<string, string> = {
  'fixture:entry': `import { mount } from 'svelte'; import Logs from './Logs.svelte'; window.start = () => mount(Logs, { target: document.body });`,
  '$api/logs': `function query(params) { const search = new URLSearchParams({ groupBy: 'chain' });
      for (const [key, value] of Object.entries(params)) if (value != null) for (const item of Array.isArray(value) ? value : [value]) search.append(key, String(item)); return search; }
    export async function queryChains(params) { window.queries.push(params); return window.realApi ? (await fetch('/api/logs?' + query(params))).json() : { data: window.rows, total: window.rows.length, totalPages: 1 }; }
    export async function exportLogs(params, format) { window.exports.push(params); return window.realApi ? (await fetch('/api/logs/export?' + query({...params, format}))).blob() : new Blob(['export']); }`,
  '$i18n': `import { readable } from 'svelte/store'; export const _ = readable((key, options) => key === 'logs.chain.attemptsSummary' ? options.values.count + ' attempts total' : key);`,
  'svelte-i18n': `import { readable } from 'svelte/store'; export const isLoading = readable(false);`,
  '$stores/toast': 'export const toast = { show() {} };',
  '$components/domain/log/ChainDetailModal.svelte': '<script>export let chain; export let onClose;</script>',
  '$components/domain/log/LogMaintenance.svelte': '<div></div>',
  '$components/ui/sheet': `export { default as Root } from 'fixture:panel.svelte'; export { default as Trigger } from 'fixture:panel.svelte'; export { default as Content } from 'fixture:panel.svelte'; export { default as Title } from 'fixture:panel.svelte';`,
  '$components/industrial': `export { default as BSelect } from 'fixture:select.svelte';
    export { default as PanelCard } from 'fixture:panel.svelte';
    export { default as BDropdownAction } from 'fixture:dropdown.svelte';
    export { default as BSwitch } from 'fixture:switch.svelte';
    export { default as LoadingIndicator } from 'fixture:loading.svelte';`,
  'fixture:select.svelte': `<script>export let options; export let value; export let onchange = undefined; export let ariaLabel;</script>
    <select aria-label={ariaLabel} value={value ?? ''} on:change={event => { value = event.currentTarget.value; onchange?.(value); }}>
      {#each options as option}<option value={option.value}>{option.label}</option>{/each}</select>`,
  'fixture:panel.svelte': '<script>let { children } = $props();</script><div>{@render children?.()}</div>',
  'fixture:dropdown.svelte': `<script>let { children, trigger, items = [], onselect } = $props();</script>
    <div>{@render trigger?.()}{@render children?.()}{#each items as item}<button onclick={() => onselect?.(item.value)}>{item.label}</button>{/each}</div>`,
  'fixture:switch.svelte': '<script>export let checked;</script><input type="checkbox" bind:checked />',
  'fixture:loading.svelte': '<span>Loading</span>',
};
const result = await Bun.build({ entrypoints: ['fixture:entry'], target: 'browser', format: 'iife', conditions: ['browser'], plugins: [{
  name: 'logs-outcomes-fixture', setup(build) {
    build.onResolve({ filter: /^\.\/Logs\.svelte$/ }, () => ({ path: `${directory}/Logs.svelte`, namespace: 'file' }));
    build.onResolve({ filter: /^\$components\/domain\/log\/outcomes$/ }, () => ({ path: resolve(directory, '../components/domain/log/outcomes.ts'), namespace: 'file' }));
    build.onResolve({ filter: /^(fixture:|\$|svelte-i18n$)/ }, args => args.path in modules ? { path: args.path, namespace: 'fixture' } : undefined);
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path.endsWith('.svelte') ? compile(modules[args.path], { filename: args.path }).js.code : modules[args.path], loader: 'js', resolveDir: directory }));
    build.onLoad({ filter: /Logs\.svelte$/ }, () => ({ contents: compile(source, { filename: `${directory}/Logs.svelte` }).js.code, loader: 'js', resolveDir: directory }));
  },
}] });
if (!result.success) throw new AggregateError(result.logs, 'Log outcomes fixture failed to compile');
const script = await result.outputs[0].text();

test('real Logs rows split HTTP, final transport and retries; filters and reset use the new API', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('http://bungee.test/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
    await page.goto('http://bungee.test/');
    await page.addScriptTag({ content: script });
    await page.evaluate(() => {
      const fixture = window as any; fixture.queries = []; fixture.exports = [];
      fixture.rows = [[200, 'completed'], [200, 'cancelled'], [200, 'failed'], [500, 'completed'], [200, undefined]].map(([status, outcome], index) => ({
        chainId: 'chain-' + index, method: 'POST', path: '/test/' + index, chainStatus: status,
        chainStartTs: 0, chainDurationMs: 12, chainAttempts: index === 0 ? 3 : 1,
        // Deliberately contradict the final chain result on the representative row.
        transportOutcome: index === 0 ? 'failed' : 'completed', chainTransportOutcome: outcome,
        success: true, upstream: 'http://upstream',
      }));
      localStorage.setItem('logsAutoRefresh', 'false'); fixture.start();
    });
    await page.waitForSelector('table tbody tr');
    const cells = await page.locator('table tbody tr').evaluateAll(rows => rows.map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent?.trim())));
    expect(cells.map(row => row[3])).toEqual(['200', '200', '200', '500', '200']);
    expect(cells.map(row => row[4])).toEqual(['logs.transport.completed', 'logs.transport.cancelled', 'logs.transport.failed', 'logs.transport.completed', 'logs.transport.unknown']);
    expect(cells[0][6]).toContain('3 attempts total');
    await page.getByRole('combobox', { name: 'logs.transportResult' }).first().selectOption('cancelled');
    await page.waitForFunction(() => (window as any).queries.at(-1).transportOutcome === 'cancelled');
    await page.getByPlaceholder('200, 404, 5xx').first().fill('200,500');
    await page.waitForFunction(() => JSON.stringify((window as any).queries.at(-1).status) === '[200,500]');
    const filtered = await page.evaluate(() => (window as any).queries.at(-1));
    expect(filtered.transportOutcome).toBe('cancelled'); expect(filtered.success).toBeUndefined();
    await page.getByRole('button', { name: 'logs.resetFilters', exact: true }).first().click();
    await page.waitForFunction(() => !(window as any).queries.at(-1).transportOutcome && !(window as any).queries.at(-1).status);
    expect(await page.getByRole('combobox', { name: 'logs.transportResult' }).first().inputValue()).toBe('__all');
    expect(errors).toEqual([]);
  } finally { await browser.close(); }
}, 15000);

test('browser filters and CSV exports match the real SQLite chain API', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'bungee-ui-sqlite-'));
  let db: Database | undefined; let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    // Load the backend at runtime so the UI checker does not include the entire core project.
    const core = resolve(directory, '../../../core/src');
    const [{ MigrationManager }, { LogQueryService }, { LogsHandler }] = await Promise.all([
      import(`${core}/migrations`), import(`${core}/api/logs`), import(`${core}/api/handlers/logs`),
    ]);
    const dbPath = resolve(root, 'access.db');
    expect((await new MigrationManager(dbPath).migrate()).success).toBeTrue();
    db = new Database(dbPath);
    const insert = db.query(`INSERT INTO access_logs (request_id,timestamp,method,path,status,duration,created_at,request_type,parent_request_id,attempt_number,transport_outcome)
      VALUES (?,?, 'POST', ?, ?, 10, ?, ?, ?, ?, ?)`);
    const now = Date.now() - 1000;
    insert.run('actual-retry', now, '/actual/retry', 503, now / 1000, 'retry', 'actual-chain', 1, 'failed');
    insert.run('actual-final', now + 10, '/actual/final', 200, now / 1000, 'final', 'actual-chain', 2, 'completed');
    insert.run('actual-cancel', now, '/actual/cancel', 200, now / 1000, 'final', null, null, 'cancelled');
    insert.run('actual-http500', now, '/actual/http500', 500, now / 1000, 'final', null, null, 'completed');
    const handler = new LogsHandler({ logQueryService: new LogQueryService(db), bodyStorage: {} as any,
      headerStorage: {} as any, cleanupService: {} as any });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage(); page.setDefaultTimeout(4000); const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://bungee.test/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
    await page.route('http://bungee.test/api/logs**', async route => {
      const request = new Request(route.request().url());
      const response = new URL(request.url).pathname.endsWith('/export') ? await handler.export(request) : await handler.query(request);
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    });
    await page.goto('http://bungee.test/'); await page.addScriptTag({ content: script });
    await page.evaluate(() => { const w = window as any; w.queries = []; w.exports = []; w.realApi = true;
      localStorage.setItem('logsAutoRefresh', 'false'); w.start(); });
    await page.waitForFunction(() => document.querySelectorAll('table tbody tr').length === 3, null, { timeout: 4000 });
    const rows = await page.locator('table tbody tr').allTextContents();
    expect(rows.find(row => row.includes('/actual/retry'))).toContain('logs.transport.completed');
    await page.getByRole('combobox', { name: 'logs.transportResult' }).first().selectOption('completed');
    await page.waitForFunction(() => document.querySelectorAll('table tbody tr').length === 2, null, { timeout: 4000 });
    await page.getByPlaceholder('200, 404, 5xx').first().fill('500');
    await page.waitForFunction(() => document.querySelectorAll('table tbody tr').length === 1
      && document.querySelector('table tbody')?.textContent?.includes('/actual/http500'), null, { timeout: 4000 });
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'CSV', exact: true }).first().click()]);
    const downloaded = await download.path();
    const csv = await Bun.file(downloaded!).text();
    expect(csv).toContain('actual-http500'); expect(csv).toContain(',completed,');
    expect(csv).not.toContain('actual-retry'); expect(csv).not.toContain('actual-cancel');
    expect(errors).toEqual([]);
  } finally { await browser?.close(); db?.close(); rmSync(root, { recursive: true, force: true }); }
}, 15000);
