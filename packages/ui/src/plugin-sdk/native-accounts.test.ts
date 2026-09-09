import { expect, test } from 'bun:test';
import { compile } from 'svelte/compiler';

const source = await Bun.file(new URL('../../../../plugins/chatgpt-oauth/ui/AccountsPage.svelte', import.meta.url)).text();
test('native account page compiles and uses standard controls, no iframe SDK or persistent authorization data', async () => {
  expect(() => compile(source, { filename: 'AccountsPage.svelte' })).not.toThrow();
  for (const component of ['IndustrialDialog', 'Select.Root', 'RadioGroup.Root', 'DropdownMenu.Root', 'StatusBadge', 'Input', 'Button']) expect(source).toContain(`<${component}`);
  expect(source).not.toMatch(/from ['"]bits-ui|BSelect|BRadioGroup|BSegmentedControl|BDropdownAction|hostRequest|initializeStyles|ServicesAPI\.(?:create|update)|localStorage|sessionStorage|<h1|<select|<iframe/);
  expect(source).toContain('sourceHandoffUrl(handoff, existing?.name)');
  const manifest = await Bun.file(new URL('../../../../plugins/chatgpt-oauth/manifest.json', import.meta.url)).json();
  expect(manifest).toMatchObject({ builtin: true, uiExtensionMode: 'native-static', contributes: { nativeSettingsComponent: 'ChatgptAccountsPage' },
    ui: { components: [{ name: 'ChatgptAccountsPage', entry: 'ui/AccountsPage.svelte' }] } });
  expect(manifest.capabilities).toContain('nativeWidgetsStatic');
  for (const file of ['accounts.js', 'accounts.css', 'index.html']) expect(await Bun.file(new URL(`../../../../plugins/chatgpt-oauth/ui/${file}`, import.meta.url)).exists()).toBe(false);
});

test('OAuth delegates modal chrome and busy close protection to IndustrialDialog', async () => {
  expect(source.match(/<IndustrialDialog\b/g)?.length).toBe(3);
  expect(source).not.toMatch(/<Dialog\./);
  expect(source).not.toMatch(/<PanelCard|<header|<footer|fixed inset|nx-panel|window\.addEventListener|keydown|stopImmediatePropagation/);
  for (const busy of ['starting', 'actionBusy']) {
    expect(source).toContain(`busy={${busy}}`);
  }
  const shared = await Bun.file(new URL('../components/industrial/IndustrialDialog.svelte', import.meta.url)).text();
  for (const primitive of ['Root', 'Content', 'Title', 'Description']) expect(shared).toContain(`<Dialog.${primitive}`);
  expect(shared).toContain('closeOnEscape={!busy} closeOnOutsideClick={!busy}');
  expect(shared).toContain('closeDisabled={busy}');
  expect(source).toContain('<svelte:window onpagehide={clearSession} />');
});

test('action icons have a fixed footprint and async actions use the standard xs indicator with stable labels', () => {
  expect(source).toContain('<LoadingIndicator size="xs" centered={false} label="" />');
  expect(source).toContain('inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center');
  expect(source).toContain('strokeWidth={1.8} aria-hidden="true"');
  expect(source).not.toContain('animate-spin');
  for (const button of source.matchAll(/<Button\b[\s\S]*?<\/Button>/g)) expect(button[0]).toContain('{@render actionIcon(');
  for (const busy of ['refreshing', 'starting', 'polling', 'submitting', 'cancelling', 'actionBusy']) expect(source).toContain(`aria-busy={${busy}}`);
  expect(source).toContain("actionIcon(RefreshCw, refreshing)}{t('ui.refresh')}");
  expect(source).not.toContain("t(refreshing ?");
});

test('actual callback handler clears input before sending, passes only session + callback and never retains it after failure', async () => {
  const handler = source.match(/  async function submitCallback\([\s\S]*?\n  }/)![0];
  const create = new Function('control', new Bun.Transpiler({ loader: 'ts' }).transformSync(`
    let session = { sessionId: 'session' }, submitting = false, status = 'pending', callback = ' http://localhost/auth/callback?code=secret ', loginNotice = '';
    const pollStatus = async () => {}, errorText = () => 'failed';
    ${handler}
    return { submitCallback, get callback() { return callback; }, get submitting() { return submitting; } };
  `));
  let finish: () => void = () => {};
  const sent: unknown[] = [];
  const field = create((...args: unknown[]) => { sent.push(args); return new Promise<void>(resolve => finish = resolve); });
  const pending = field.submitCallback({ preventDefault() {} });
  expect(field.callback).toBe(''); expect(field.submitting).toBe(true);
  expect(sent).toEqual([['POST', '/login/callback', { sessionId: 'session', callbackUrl: 'http://localhost/auth/callback?code=secret' }]]);
  finish(); await pending; expect(field.callback).toBe(''); expect(field.submitting).toBe(false);
  const failed = create(async () => { throw new Error('offline'); });
  await failed.submitCallback({ preventDefault() {} }); expect(failed.callback).toBe(''); expect(failed.submitting).toBe(false);
});

test('service editor consumes query before loading and preserves drafts against late responses, with duplicate focus', async () => {
  const editor = await Bun.file(new URL('../routes/ServiceEditor.svelte', import.meta.url)).text();
  const mount = editor.slice(editor.indexOf('onMount(async () =>'));
  expect(mount.indexOf('consumeSourceHandoff(query)')).toBeLessThan(mount.indexOf('await RoutesAPI.list()'));
  expect(mount.indexOf('window.history.replaceState')).toBeLessThan(mount.indexOf('prepareSourceHandoff'));
  expect(mount).toContain('JSON.stringify(service) !== before');
  expect(mount).toContain('lifetime.signal.aborted');
  expect(mount).toContain('focusIndex = result.index');
  expect(mount).toContain('upstreamSection?.openUpstreamModal(focusIndex)');
  expect(mount).not.toMatch(/ServicesAPI\.(?:update|create)/);
  expect(mount).not.toContain("split('?')");
});

test('all account UI and model messages have both plugin locales; no hardcoded visible Chinese', async () => {
  const manifest = await Bun.file(new URL('../../../../plugins/chatgpt-oauth/manifest.json', import.meta.url)).json();
  const model = await Bun.file(new URL('../../../../plugins/chatgpt-oauth/ui/account-model.js', import.meta.url)).text();
  expect(source + model).not.toMatch(/[\u3400-\u9fff]/);
  expect(Object.keys(manifest.translations.en).sort()).toEqual(Object.keys(manifest.translations['zh-CN']).sort());
  const keys = [...(source + model).matchAll(/['"]((?:ui|login|account|errors)\.[a-zA-Z_]+)['"]/g)].map(match => match[1]);
  for (const key of keys) for (const lang of ['en', 'zh-CN']) expect(manifest.translations[lang][key]).toBeTruthy();
  expect(source).toContain('getPluginText'); expect(source).toContain('$isLoading ?');
});
