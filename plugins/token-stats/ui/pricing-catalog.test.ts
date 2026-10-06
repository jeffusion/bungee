import { expect, test } from 'bun:test';
import { createPricingModelSearch, type PricingModelPage, type PricingModelSearchState } from './pricing-catalog';

const option = (model: string) => ({ provider: 'custom-provider', providerName: 'Custom provider', model, name: model });
const page = (models: string[], current = 1): PricingModelPage => ({ models: models.map(option), total: 8394, page: current, pageSize: 50 });
const deferred = () => { let resolve!: (page: PricingModelPage) => void; const promise = new Promise<PricingModelPage>(done => resolve = done); return { resolve, promise }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

test('does not preload and requests only the selected provider page', async () => {
  const paths: string[] = [];
  const states: PricingModelSearchState[] = [];
  const search = createPricingModelSearch(async path => { paths.push(path); return page(['ExactCase']); }, state => states.push(state));
  expect(paths).toEqual([]);
  search.search({ provider: 'custom-provider', search: '' }, 1, false);
  await tick();
  expect(paths).toEqual(['/pricing/models?provider=custom-provider&search=&page=1&pageSize=50']);
  expect(states.at(-1)?.models[0]?.model).toBe('ExactCase');
  // A large total never triggers another page automatically.
  expect(paths).toHaveLength(1);
  search.search({ provider: 'custom-provider', search: '' }, 2, false);
  await tick();
  expect(paths.at(-1)).toContain('page=2&pageSize=50');
  search.destroy();
});

test('debounces remote searches and preserves query characters and model case', async () => {
  const paths: string[] = [];
  const states: PricingModelSearchState[] = [];
  const search = createPricingModelSearch(async path => { paths.push(path); return page(['DeepSeek/V4 & 中文']); }, state => states.push(state), 5);
  search.search({ provider: 'custom-provider', search: 'first' });
  search.search({ provider: 'custom-provider', search: 'DeepSeek/V4 & 中文' });
  await tick();
  expect(paths).toEqual(['/pricing/models?provider=custom-provider&search=DeepSeek%2FV4+%26+%E4%B8%AD%E6%96%87&page=1&pageSize=50']);
  expect(states.at(-1)?.models[0]?.model).toBe('DeepSeek/V4 & 中文');
  search.destroy();
});

test('provider changes, closure and destruction reject late results', async () => {
  const requests = [deferred(), deferred(), deferred()];
  const signals: AbortSignal[] = [];
  const states: PricingModelSearchState[] = [];
  const search = createPricingModelSearch((_path, signal) => { signals.push(signal); return requests[signals.length - 1]!.promise; }, state => states.push(state));
  search.search({ provider: 'old', search: '' }, 1, false);
  search.search({ provider: 'new', search: '' }, 1, false);
  expect(signals[0]!.aborted).toBe(true);
  requests[0]!.resolve(page(['OLD'])); await tick();
  expect(states.at(-1)?.models).toEqual([]);
  requests[1]!.resolve(page(['New'])); await tick();
  expect(states.at(-1)?.models[0]?.model).toBe('New');
  search.search({ provider: 'new', search: '' }, 1, false);
  search.cancel(); expect(signals[2]!.aborted).toBe(true);
  const count = states.length;
  requests[2]!.resolve(page(['Late'])); await tick();
  expect(states).toHaveLength(count);
  search.destroy(); search.search({ provider: 'ignored', search: '' }, 1, false);
  expect(signals).toHaveLength(3);
});


// Exercise the actual Svelte load functions with controlled response ordering.
async function settingsFixture(loadRequest: (plugin: string, path: string) => Promise<unknown>) {
  const source = await Bun.file(new URL('./TokenStatsSettings.svelte', import.meta.url)).text();
  const providers = source.slice(source.indexOf('  async function loadProviders('), source.indexOf('  async function loadMappings('));
  const load = source.slice(source.indexOf('  async function load()'), source.indexOf('  onMount('));
  const code = `function fixture(requestPluginControl: any) {
    let alive = true, polling = false, loading = true, error = '', providersError = false;
    let status: any = null, catalogVersion: number | null = null, providers: any[] = [];
    let providersVersion: number | null | undefined, providersPendingVersion: number | null | undefined, providersGeneration = 0;
    const controller = new AbortController();
    ${providers}
    ${load}
    return { load, state: () => ({ status, providers, catalogVersion, loading, providersError }) };
  }`;
  const javascript = new Bun.Transpiler({ loader: 'ts' }).transformSync(code);
  return new Function(`${javascript}
return fixture;`)()(loadRequest);
}

test('settings displays status without waiting for providers and ignores a superseded directory response', async () => {
  let version = 1;
  const pending: Array<(value: unknown) => void> = [];
  let calls = 0;
  const settings = await settingsFixture(async (_plugin, path) => {
    if (path === '/pricing') return { version, modelCount: 100 };
    calls++;
    return new Promise(resolve => pending.push(resolve));
  });
  await settings.load();
  expect(settings.state()).toMatchObject({ loading: false, catalogVersion: 1 });
  // A poll during a slow provider request does not keep aborting/restarting it.
  await settings.load(); expect(calls).toBe(1);
  version = 2;
  await settings.load(); expect(calls).toBe(2);
  pending[1]!({ providers: [{ provider: 'new' }] }); await tick();
  pending[0]!({ providers: [] }); await tick();
  expect(settings.state().providers).toEqual([{ provider: 'new' }]);
  await settings.load(); expect(calls).toBe(2);
});

test('settings recovers provider selection when an initially empty directory gets its first version', async () => {
  let version: number | null = null;
  let calls = 0;
  const settings = await settingsFixture(async (_plugin, path) => {
    if (path === '/pricing') return { version, modelCount: version === null ? 0 : 100 };
    calls++;
    return { providers: version === null ? [] : [{ provider: 'available' }] };
  });
  await settings.load(); await tick();
  expect(settings.state().providers).toEqual([]);
  version = 1;
  await settings.load(); await tick();
  expect(settings.state().providers).toEqual([{ provider: 'available' }]);
  expect(calls).toBe(2);
});
