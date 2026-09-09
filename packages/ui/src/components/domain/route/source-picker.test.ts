import { expect, test } from 'bun:test';
import { compile } from 'svelte/compiler';

const source = await Bun.file(new URL('./UpstreamSourcePicker.svelte', import.meta.url)).text();
const fn = (name: string) => source.match(new RegExp(`  (?:async )?function ${name}\\([\\s\\S]*?\\n  }`))![0];
const body = new Bun.Transpiler({ loader: 'ts' }).transformSync(`
  let { upstream, sources, listSourceAccounts } = initial;
  let selected = 'manual', accounts = [], accountId = '', error = '', loading = false, generation = 0;
  const lifetime = new AbortController(), resolved = [], onresolve = label => resolved.push(label), $_ = key => key;
  const key = item => item.plugin.name + '/' + item.contribution.id;
  ${fn('boundAccountRef')}
  ${fn('loadAccounts')}
  return { loadAccounts, get state() { return { selected, accounts, accountId, error, loading }; }, resolved };
`);
const create = new Function('initial', body);
const chosen = { plugin: { name: 'provider', enabled: true }, contribution: { id: 'source' } };
test('source radio and account select use direct shadcn primitives with disabled states and callbacks', () => {
  expect(source).toContain('<RadioGroup.Root'); expect(source).toContain('onValueChange={loadAccounts}'); expect(source).toContain('<Select.Root');
  expect(source).not.toContain('<select'); expect(source).not.toMatch(/bits-ui|BSelect|BRadioGroup|BSwitch|IndustrialToggle/);
  expect(source).toContain('disabled={!item.plugin.enabled || applying || loading}'); expect(source).toContain('disabled={!item.available}');
  expect(source).toContain('label={selectedAccount?.label} disabled');
  expect(source).toContain('onSelectedChange={(next) => accountId = next?.value');
  expect(() => compile(source, { filename: 'UpstreamSourcePicker.svelte' })).not.toThrow();
});
test('missing current account remains selected and disabled during loading/error; retry recovers without changing upstream', async () => {
  const upstream = { managedBy: { plugin: 'provider', contributionId: 'source', bindingId: 'binding' }, plugins: [{ _uid: 'binding', options: { accountRef: 'missing' } }] };
  let fail = true;
  const field = create({ upstream, sources: [chosen], listSourceAccounts: async () => { if (fail) throw new Error('offline'); return [{ id: 'other', label: '其他账号', available: false }]; } });
  await field.loadAccounts('provider/source');
  expect(field.state).toMatchObject({ accountId: 'missing', error: 'upstream.sourceOperationFailed', loading: false });
  fail = false; await field.loadAccounts('provider/source');
  expect(field.state).toMatchObject({ accountId: 'missing', error: '', loading: false });
  expect(field.resolved).toEqual([null]);
  expect(upstream.plugins[0].options.accountRef).toBe('missing');
});
test('late account result cannot overwrite a newer manual selection', async () => {
  let finish: (value: unknown[]) => void = () => {};
  const field = create({ upstream: {}, sources: [chosen], listSourceAccounts: () => new Promise(resolve => finish = resolve) });
  const pending = field.loadAccounts('provider/source');
  expect(field.state.loading).toBe(true);
  await field.loadAccounts('manual'); finish([{ id: 'late' }]); await pending;
  expect(field.state).toMatchObject({ selected: 'manual', accounts: [], loading: false });
});

test('late authoritative draft cannot overwrite newer endpoint edits and disabled source never starts an apply', async () => {
  const applyBody = new Bun.Transpiler({ loader: 'ts' }).transformSync(`
    let { upstream, source, createSourceDraft } = initial;
    const account = { id: 'account', label: '账号', available: true }, lifetime = new AbortController();
    let applying = false, loading = false, generation = 0, error = '';
    const resolved = [], onresolve = value => resolved.push(value), $_ = value => value;
    const applySourceDraft = () => { throw new Error('Must not replace the newer draft'); };
    ${fn('apply')}
    return { apply, get upstream() { return upstream; }, resolved };
  `);
  const createApply = new Function('initial', applyBody);
  let finish: (value: unknown) => void = () => {};
  const upstream = { target: 'https://original.test' };
  const field = createApply({ upstream, source: chosen, createSourceDraft: () => new Promise(resolve => finish = resolve) });
  const pending = field.apply(); upstream.target = 'https://newer-edit.test'; finish({ target: 'https://late.test' }); await pending;
  expect(field.upstream.target).toBe('https://newer-edit.test'); expect(field.resolved).toEqual([]);
  let requests = 0;
  const disabled = createApply({ upstream, source: { ...chosen, plugin: { ...chosen.plugin, enabled: false } }, createSourceDraft: () => requests++ });
  await disabled.apply(); expect(requests).toBe(0);
});
