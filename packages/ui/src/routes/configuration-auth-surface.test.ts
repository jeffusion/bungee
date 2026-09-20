import { expect, test } from 'bun:test';

test('settings inputs explicitly reference visible labels and instance-safe help', async () => {
  const configuration = await Bun.file(new URL('./Configuration.svelte', import.meta.url)).text();
  expect(configuration).toContain('id="config-request-limit-label" for="config-request-limit"');
  expect(configuration).toContain('<Input id="config-request-limit" aria-labelledby="config-request-limit-label"');
  expect(configuration).toContain('aria-describedby="config-request-limit-help"');
  const logging = await Bun.file(new URL('../components/domain/config/LoggingEditor.svelte', import.meta.url)).text();
  expect(logging).toContain('const id = $props.id()');
  expect(logging).toContain('id={`${id}-body`}');
  for (const [field, label, help] of [['max-size', 'size-label', 'size-help'], ['retention-days', 'retention-label', 'retention-help']]) {
    expect(logging).toContain('id={`${id}-' + label + '`} for={`${id}-' + field + '`}');
    expect(logging).toContain('id={`${id}-' + field + '`} aria-labelledby={`${id}-' + label + '`}');
    expect(logging).toContain('aria-describedby={`${id}-' + help + '`}');
    expect(logging).not.toContain(` id="logging-${field}"`);
  }
});

test('settings presentation uses plural counts and a single review dismissal', async () => {
  const source = await Bun.file(new URL('./Configuration.svelte', import.meta.url)).text();
  expect(source).toContain("$_('settings.changeCount', { values: { count: diff.length } })");
  expect(source).not.toContain("t('changes')");
  expect(source.split('{#snippet footer()}')[1]).not.toContain("t('closeReview')");
  expect(source).toContain('if (!open) cancelReview()');
  expect(source).toContain('{#key draft.log_level}');
  for (const locale of ['zh-CN', 'en']) {
    const { settings } = await Bun.file(new URL(`../i18n/locales/${locale}.json`, import.meta.url)).json();
    expect(settings.changeCount).toBe(locale === 'en' ? '{count, plural, one {# change} other {# changes}}' : '{count} 项更改');
    expect(settings.bodySizeHelp).toContain(locale === 'en' ? 'default: 5 KiB' : '默认 5 KiB');
  }
});

test('global settings keeps review, import and auth proof inside the industrial workspace', async () => {
  const source = await Bun.file(new URL('./Configuration.svelte', import.meta.url)).text();
  expect(source).toContain('class="nx-page settings-workspace py-5 space-y-5" data-testid="page-config"');
  expect(source).not.toContain('KpiCard');
  for (const id of ['settings-draft-state', 'settings-publication-state', 'settings-serving-state', 'config-review', 'settings-change-bar']) {
    expect(source).toContain(`data-testid="${id}"`);
  }
  expect(source).toContain('<ConfigurationDiff changes={diff} />');
  expect(source.indexOf('data-testid="next-auth-section"')).toBeGreaterThan(source.indexOf('id="settings-access"'));
  expect(source.indexOf('data-testid="next-auth-section"')).toBeLessThan(source.indexOf('id="settings-logging"'));
  expect(source).toContain('validSignature === signature');
  const dispatch = source.slice(source.indexOf('onDispatch:'), source.indexOf('onOperation:', source.indexOf('onDispatch:')));
  expect(dispatch).not.toContain('sessionStorage');
  expect(dispatch).not.toContain('retainAccepted');
  expect(source).toContain('retainAccepted(state.operation.mutation_id)');
  expect(source).not.toContain('localStorage.setItem');
  const selection = source.slice(source.indexOf('async function selectImport'), source.indexOf('function cancelReview'));
  expect(selection).toContain('parseImportPreview');
  expect(selection).not.toContain('importConfig(');
  expect(selection).not.toContain('validateAggregate(');
});

test('localized names and real primitives; cleanup is only on Logs', async () => {
  for (const [locale, name] of [['zh-CN', '全局设置'], ['en', 'Global Settings']]) {
    const messages = await Bun.file(new URL(`../i18n/locales/${locale}.json`, import.meta.url)).json();
    expect(messages.configuration.title).toBe(name);
    expect(messages.nav.configuration).toBe(name);
  }
  const auth = await Bun.file(new URL('../components/domain/config/AuthEditor.svelte', import.meta.url)).text();
  expect(auth).toContain("type={revealed ? 'text' : 'password'}");
  expect(auth).toContain('aria-label=');
  expect(auth).toContain('<IndustrialToggle');
  const configuration = await Bun.file(new URL('./Configuration.svelte', import.meta.url)).text();
  expect(configuration).toContain("import * as Select from '$components/ui/select'");
  expect(configuration).not.toMatch(/<select\b/);
  expect(configuration).toContain('disabled={locked || reviewOpen || !!imported}');
  const logs = await Bun.file(new URL('../components/domain/config/LoggingEditor.svelte', import.meta.url)).text();
  expect(logs).not.toContain('triggerCleanup');
  expect(logs).not.toContain('BSwitch');
  expect(await Bun.file(new URL('./Logs.svelte', import.meta.url)).text()).toContain('<LogMaintenance />');
});
