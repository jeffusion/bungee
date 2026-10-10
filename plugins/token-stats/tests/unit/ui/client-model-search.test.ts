import { describe, expect, test } from 'bun:test';
import { createClientModelSearch, type ClientModelPage, type ClientModelSearchState } from '../../../ui/client-model-search';

const page = (models: string[], current = 1): ClientModelPage => ({ models, page: current, pageSize: 50, total: 101 });
const deferred = () => { let resolve!: (page: ClientModelPage) => void; const promise = new Promise<ClientModelPage>(done => resolve = done); return { resolve, promise }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

describe('client model search lifecycle', () => {
  test('debounces typing and preserves exact search case and query characters', async () => {
    const paths: string[] = [];
    const states: ClientModelSearchState[] = [];
    const search = createClientModelSearch(async path => { paths.push(path); return page(['DeepSeek/V4 & 中文']); }, state => states.push(state), 5);
    search.search('first'); search.search('DeepSeek/V4 & 中文');
    expect(paths).toHaveLength(0);
    await tick();
    expect(paths).toEqual(['/models?search=DeepSeek%2FV4+%26+%E4%B8%AD%E6%96%87&page=1&pageSize=50']);
    expect(states.at(-1)?.models).toEqual(['DeepSeek/V4 & 中文']);
    search.destroy();
  });
  test('aborts old requests during debounce and rejects late responses', async () => {
    const pending = [deferred(), deferred()];
    const signals: AbortSignal[] = [];
    const states: ClientModelSearchState[] = [];
    const search = createClientModelSearch((_path, signal) => { signals.push(signal); return pending[signals.length - 1].promise; }, state => states.push(state), 5);
    search.search('old', 1, false);
    search.search('new');
    expect(signals[0].aborted).toBe(true);
    pending[0].resolve(page(['OLD'])); await tick();
    expect(states.at(-1)?.models).toEqual([]);
    pending[1].resolve(page(['New'])); await tick();
    expect(states.at(-1)?.models).toEqual(['New']);
    search.destroy();
  });
  test('requests later pages and aborts on component destruction without publishing', async () => {
    const pending = deferred();
    let signal!: AbortSignal;
    let path = '';
    const states: ClientModelSearchState[] = [];
    const search = createClientModelSearch((requested, incoming) => { path = requested; signal = incoming; return pending.promise; }, state => states.push(state));
    search.search('MixedCase', 3, false);
    expect(path).toBe('/models?search=MixedCase&page=3&pageSize=50');
    search.destroy(); expect(signal.aborted).toBe(true);
    pending.resolve(page(['Late'], 3)); await tick();
    expect(states).toHaveLength(1);
    search.search('ignored', 1, false); expect(states).toHaveLength(1);
  });
  test('reports search failure and accepts another query after failure', async () => {
    const states: ClientModelSearchState[] = [];
    let fail = true;
    const search = createClientModelSearch(async () => { if (fail) throw new Error('offline'); return page(['ExactCASE']); }, state => states.push(state));
    search.search('', 1, false); await tick();
    expect(states.at(-1)?.error).toBe(true);
    fail = false; search.search('ExactCASE', 1, false); await tick();
    expect(states.at(-1)?.error).toBe(false);
    expect(states.at(-1)?.models).toEqual(['ExactCASE']);
    search.destroy();
  });
});
