import { expect, test } from 'bun:test';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
    expect(generated).toContain("LocalAccountsLogin: 'local-accounts'");
    const translations = JSON.parse(generated.match(/export const generatedPluginTranslations = ([\s\S]*?) as const;/)![1]);
    const manifest = await Bun.file(new URL('../../../../../plugins/local-accounts/manifest.json', import.meta.url)).json();
    for (const locale of ['en', 'zh-CN']) {
      expect(Object.keys(translations[locale])).toEqual(['plugins']);
      expect(Object.keys(translations[locale].plugins)).toEqual(['local-accounts']);
      expect(translations[locale].plugins['local-accounts']).toEqual(manifest.translations[locale]);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('public login messages are generated only from the selected plugin directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-login-registry-'));
  try {
    const pluginsDirectory = join(directory, 'plugins');
    await mkdir(pluginsDirectory);
    const pluginDirectory = join(pluginsDirectory, 'local-accounts');
    await cp(fileURLToPath(new URL('../../../../../plugins/local-accounts', import.meta.url)), pluginDirectory, { recursive: true });
    const manifestFile = join(pluginDirectory, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    // This case tests copied-manifest isolation, translations, and UI ownership only.
    // The real-repository case above covers bundling the actual plugin runtime entries.
    await writeFile(join(pluginDirectory, manifest.main), 'export default {};');
    if (manifest.control?.entry) await writeFile(join(pluginDirectory, manifest.control.entry), 'export default {};');
    const outputFile = join(directory, 'generated.ts');
    await generateWidgetRegistry({ pluginsDirectory, outputFile });
    const generated = await readFile(outputFile, 'utf8');
    expect(generated).toContain("import LocalAccountsLogin from '@plugins/local-accounts/ui/Login.svelte'");
    expect(generated).not.toContain('@plugins/token-stats/');
    const translations = JSON.parse(generated.match(/export const generatedPluginTranslations = ([\s\S]*?) as const;/)![1]);
    for (const locale of ['en', 'zh-CN']) {
      expect(Object.keys(translations[locale])).toEqual(['plugins']);
      expect(Object.keys(translations[locale].plugins)).toEqual(['local-accounts']);
      expect(translations[locale].plugins['local-accounts']).toEqual(manifest.translations[locale]);
    }
    expect(generated).not.toMatch(/import\s*\(/);
    manifest.management.loginComponent = 'ForeignLogin';
    await writeFile(manifestFile, JSON.stringify(manifest));
    // Reuse the catalog's ownership validation; no separate login ownership system.
    await expect(generateWidgetRegistry({ pluginsDirectory, outputFile })).rejects.toThrow('management loginComponent must be a declared UI component');
    expect(await readFile(outputFile, 'utf8')).toBe(generated);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
