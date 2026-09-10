import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateWidgetRegistry } from '../../../../../scripts/generate-widget-registry';

test('real repository generation retains the real TokenStatsChart and ChatgptAccountsPage with their owners', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-widget-registry-'));
  try {
    const outputFile = join(directory, 'generated.ts');
    const pluginsDirectory = fileURLToPath(new URL('../../../../../plugins', import.meta.url));
    const tokenManifest = JSON.parse(await readFile(join(pluginsDirectory, 'token-stats/manifest.json'), 'utf8'));
    expect(tokenManifest.builtin).not.toBe(true);
    await generateWidgetRegistry({ pluginsDirectory, outputFile });
    const generated = await readFile(outputFile, 'utf8');
    expect(await readFile(new URL('./generated.ts', import.meta.url), 'utf8')).toBe(generated);
    expect(generated).toContain("import TokenStatsChart from '@plugins/token-stats/ui/TokenStatsChart.svelte'");
    expect(generated).toContain("import ChatgptAccountsPage from '@plugins/chatgpt-oauth/ui/AccountsPage.svelte'");
    expect(generated).toContain("TokenStatsChart: 'token-stats'");
    expect(generated).toContain("ChatgptAccountsPage: 'chatgpt-oauth'");
    expect(generated).toContain("import ChatgptQuotaWidget from '@plugins/chatgpt-oauth/ui/ChatgptQuotaWidget.svelte'");
    expect(generated).toContain("ChatgptQuotaWidget: 'chatgpt-oauth'");
    expect(generated).toMatch(/generatedWidgetRegistry[\s\S]*\n  ChatgptQuotaWidget,/);
    expect(generated).toMatch(/generatedWidgetRegistry[\s\S]*\n  TokenStatsChart,/);
    expect(generated).toMatch(/generatedWidgetRegistry[\s\S]*\n  ChatgptAccountsPage,/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
