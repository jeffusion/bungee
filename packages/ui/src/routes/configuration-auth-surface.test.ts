import { describe, expect, test } from 'bun:test';

describe('configuration auth rotation surface', () => {
  test('renders the next-auth section after the always-visible form', async () => {
    // Given
    const source = await Bun.file(new URL('./Configuration.svelte', import.meta.url)).text();
    const formEnd = source.indexOf('</SystemAlertBar>');

    // When
    const nextAuthSection = source.indexOf('data-testid="next-auth-section"');

    // Then
    expect(formEnd).toBeGreaterThan(0);
    expect(nextAuthSection).toBeGreaterThan(formEnd);
    expect(source).not.toContain('editMode');
  });
});

test('configuration is form-only while retaining snapshot import/export and validation', async () => {
  const source = await Bun.file(new URL('./Configuration.svelte', import.meta.url)).text();
  expect(source).not.toMatch(/editMode|jsonText|jsonError|handleJsonChange|SegmentedControl|Textarea|JSON ERROR|VALID BUFFER/);
  for (const contract of [
    '<AuthEditor bind:value={editingConfig.auth}', '<LoggingEditor bind:value={editingConfig.logging}',
    'validateConfig(loadedSnapshot, editingConfig)', 'updateConfig(loadedSnapshot, editingConfig,',
    'importConfig(loadedSnapshot, envelope,', "fetch('/__ui/api/config/export'",
    "input.accept = '.json'", 'runImport(JSON.parse(await file.text()))',
    'pendingImportEnvelope = envelope', 'importNextAuthRequired = true',
    'envelope.source_revision', 'disabled={saving || loading || !isDirty}',
  ]) expect(source).toContain(contract);
  for (const locale of ['en', 'zh-CN']) {
    const messages = await Bun.file(new URL(`../i18n/locales/${locale}.json`, import.meta.url)).json();
    for (const key of ['formEditor', 'jsonEditor', 'jsonConfiguration', 'jsonParseError', 'jsonPlaceholder', 'jsonHelp']) {
      expect(messages.configuration[key]).toBeUndefined();
    }
  }
});

test('form saves preserve unseen fields, dirty state, validation and auth proof through the loaded snapshot', async () => {
  const source = await Bun.file(new URL('./Configuration.svelte', import.meta.url)).text();
  const functions = ['loadConfig', 'handleSave', 'configSnapshot'].map(name => {
    const fn = source.match(new RegExp(`  (?:async )?function ${name}\\([\\s\\S]*?\\n  }`))?.[0];
    if (!fn) throw new Error(`Missing page function: ${name}`);
    return fn;
  }).join('\n');
  const dirty = source.match(/\$: isDirty = ([^;]+);/)?.[1];
  expect(dirty).toBeDefined();
  const body = new Bun.Transpiler({ loader: 'ts' }).transformSync(`
    let config = null, editingConfig = null, loadedSnapshot = null;
    let error = null, loading = true, saving = false, nextAuthRequired = false, nextAuthToken = '';
    const { getConfigSnapshot, validateConfig, updateConfig } = api;
    const toast = { show() {} }, $_ = key => key;
    ${functions}
    return { loadConfig, handleSave, get draft() { return editingConfig; },
      get dirty() { return ${dirty}; }, get saving() { return saving; },
      proof(token) { nextAuthRequired = true; nextAuthToken = token; } };
  `);
  let snapshot = { revision: 34, content_hash: 'test-hash', config: { logical_configuration: {
    log_level: 'info', routes: [{ path: '/keep' }], services: { keep: { endpoints: [] } },
    plugins: [{ name: 'keep-plugin' }], unexposed: { nested: ['preserve'] },
  } } };
  const original = structuredClone(snapshot);
  let valid = true, reject = false;
  const writes: any[] = [], validations: any[] = [];
  const page = new Function('api', body)({
    getConfigSnapshot: async () => snapshot,
    validateConfig: async (...args: any[]) => { validations.push(args); return { valid }; },
    updateConfig: async (...args: any[]) => {
      writes.push(args);
      if (reject) throw new Error('stale snapshot');
      snapshot = { ...snapshot, revision: 35, config: { logical_configuration: structuredClone(args[1]) } };
      return { success: true };
    },
  });
  await page.loadConfig();
  expect(page.dirty).toBe(false);
  page.draft.log_level = 'debug';
  expect(page.dirty).toBe(true);
  expect(original.config.logical_configuration.log_level).toBe('info');
  valid = false; await page.handleSave(); expect(writes).toHaveLength(0);
  expect(page.dirty).toBe(true); expect(page.saving).toBe(false);
  valid = true; page.proof(''); await page.handleSave(); expect(writes).toHaveLength(0);
  page.proof(' demo-proof '); reject = true; await page.handleSave();
  expect(page.draft.log_level).toBe('debug'); expect(page.dirty).toBe(true);
  reject = false; await page.handleSave();
  expect(writes.at(-1)[0]).toEqual(original);
  expect(writes.at(-1)[1]).toEqual({ ...original.config.logical_configuration, log_level: 'debug' });
  expect(writes.at(-1)[2]).toEqual({ nextAuthorization: 'demo-proof' });
  expect(validations.at(-1)[0]).toEqual(original);
  expect(page.dirty).toBe(false); expect(page.saving).toBe(false);
});

describe('configuration page next-auth surface', () => {
  test('next-auth section is driven only by an auth change or pending import', async () => {
    // Given
    const source = await Bun.file(new URL('./Configuration.svelte', import.meta.url)).text();

    // Then
    expect(source).toContain('$: nextAuthRequired = editingConfig?.auth?.enabled === true && authWillChange;');
  });
});

describe('configuration auth token lifecycle', () => {
  test('clears the persisted token after disabled auth converges', async () => {
    const source = await Bun.file(new URL('../api/config.ts', import.meta.url)).text();

    expect(source).toContain("import { login, logout } from '$stores/auth';");
    expect(source.match(/logout\(\);/g)).toHaveLength(2);
  });
});

describe('configuration page layout contract', () => {
  test('page root uses the semantic nx-page standard-width container', async () => {
    // Given
    const source = await Bun.file(new URL('./Configuration.svelte', import.meta.url)).text();

    // When
    const match = source.match(/<div class="([^"]*)" data-testid="page-config"/);

    // Then
    expect(match).not.toBeNull();
    const classes = match![1];
    expect(classes).toContain('nx-page');
    expect(classes).toContain('py-5 space-y-5');
    expect(classes).not.toMatch(/\bmax-w-/);
    expect(classes).not.toContain('px-6');
  });
});

describe('setting-row switches are icon-only with localized accessible names', () => {
  test.each([
    ['AuthEditor', '../components/domain/config/AuthEditor.svelte', 'auth.enableAuth'],
    ['LoggingEditor', '../components/domain/config/LoggingEditor.svelte', 'logging.bodyRecording'],
  ])('%s first BSwitch carries description instead of a visible label', async (_name, relative, key) => {
    // Given
    const source = await Bun.file(new URL(relative, import.meta.url)).text();

    // When
    const switchTag = source.match(/<BSwitch([\s\S]*?)\/>/)!;

    // Then
    expect(switchTag).not.toBeNull();
    const props = switchTag[1];
    expect(props).toContain(`description={$_('${key}')}`);
    expect(props).not.toContain('label=');
  });
});
