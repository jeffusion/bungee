import { expect, test } from 'bun:test';
import { loadPricingModels } from './pricing-catalog';

const option = (model: string) => ({ provider: 'custom-provider', providerName: 'Custom provider', model, name: model });

test('loads every pricing page including targets outside the first page', async () => {
  const paths: string[] = [];
  const result = await loadPricingModels(async path => {
    paths.push(path);
    const page = Number(new URL(`http://test${path}`).searchParams.get('page'));
    return { models: page === 1 ? [option('FIRST')] : [option('ValidLaterTarget')], total: 2, page, pageSize: 1 };
  }, new AbortController().signal);
  expect(paths).toEqual(['/pricing/models?page=1&pageSize=100', '/pricing/models?page=2&pageSize=100']);
  expect(result.map(model => model.model)).toEqual(['FIRST', 'ValidLaterTarget']);
});

test('a later page failure never returns a partial catalog', async () => {
  await expect(loadPricingModels(async path => {
    if (path.includes('page=2&')) throw new Error('offline');
    return { models: [option('FIRST')], total: 2, page: 1, pageSize: 1 };
  }, new AbortController().signal)).rejects.toThrow('offline');
});

test('aborting catalog load stops before requesting another page', async () => {
  const controller = new AbortController();
  let calls = 0;
  await expect(loadPricingModels(async () => {
    calls++; controller.abort();
    return { models: [option('FIRST')], total: 2, page: 1, pageSize: 1 };
  }, controller.signal)).rejects.toThrow('Aborted');
  expect(calls).toBe(1);
});
