import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateWidgetRegistry } from '../../../../../scripts/generate-widget-registry';
import { normalizeText } from '../../../../../tests/support/portable-text';

test('real repository generation retains dashboard and settings components with their owners', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-widget-registry-'));
  try {
    const outputFile = join(directory, 'generated.ts');
    const pluginsDirectory = fileURLToPath(new URL('../../../../../plugins', import.meta.url));
    await generateWidgetRegistry({ pluginsDirectory, outputFile });
    const generated = await readFile(outputFile, 'utf8');
    expect(normalizeText(await readFile(new URL('./generated.ts', import.meta.url), 'utf8'))).toBe(normalizeText(generated));
    expect(generated).toContain("import TokenStatsChart from '@plugins/token-stats/ui/TokenStatsChart.svelte'");
    expect(generated).toContain("import ChatgptAccountsPage from '@plugins/chatgpt-oauth/ui/AccountsPage.svelte'");
    expect(generated).toContain("TokenStatsChart: 'token-stats'");
    expect(generated).toContain("import TokenStatsSettings from '@plugins/token-stats/ui/TokenStatsSettings.svelte'");
    expect(generated).toContain("TokenStatsSettings: 'token-stats'");
    expect(generated).toMatch(/generatedWidgetRegistry[\s\S]*\n  TokenStatsSettings,/);
    expect(generated).toContain("ChatgptAccountsPage: 'chatgpt-oauth'");
    expect(generated).toContain("import ChatgptQuotaWidget from '@plugins/chatgpt-oauth/ui/ChatgptQuotaWidget.svelte'");
    expect(generated).toContain("ChatgptQuotaWidget: 'chatgpt-oauth'");
    expect(generated).toMatch(/generatedWidgetRegistry[\s\S]*\n  ChatgptQuotaWidget,/);
    expect(generated).toMatch(/generatedWidgetRegistry[\s\S]*\n  TokenStatsChart,/);
    expect(generated).toMatch(/generatedWidgetRegistry[\s\S]*\n  ChatgptAccountsPage,/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
