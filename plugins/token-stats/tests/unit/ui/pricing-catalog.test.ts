import { expect, test } from 'bun:test';
import { createPricingModelSearch, type PricingModelPage, type PricingModelSearchState } from '../../../ui/pricing-catalog';

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
