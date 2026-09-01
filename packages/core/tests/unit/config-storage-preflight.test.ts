import { describe, expect, test } from 'bun:test';
import { parseNormalizeCompile } from '../../src/config-storage';

function summary(input: unknown): readonly { code: string; path: string }[] {
  const result = parseNormalizeCompile(input);
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.errors.map(({ code, path }) => ({ code, path }));
}

describe('configuration JSON graph preflight', () => {
  test('distinguishes omitted collections from explicitly undefined values', () => {
    expect(parseNormalizeCompile({})).toMatchObject({ ok: true });
    expect(summary({ services: undefined, routes: undefined, plugins: undefined })).toEqual([
      { code: 'non_json_value', path: 'services' },
      { code: 'non_json_value', path: 'routes' },
      { code: 'non_json_value', path: 'plugins' },
    ]);
    expect(summary({ plugins: [{ id: 'abcdefab-cdef-4abc-8def-abcdefabc100', name: 'x', options: undefined }] }))
      .toEqual([{ code: 'non_json_value', path: 'plugins[0].options' }]);
  });

  test('rejects sparse arrays in collections and JSON option arrays', () => {
    const services = new Array<unknown>(1);
    const routes = new Array<unknown>(1);
    const plugins = new Array<unknown>(1);
    const endpoints = new Array<unknown>(1);
    const nestedPlugins = new Array<unknown>(1);
    const optionItems = new Array<unknown>(1);
    expect(summary({ services, routes, plugins, auth: { endpoints, plugins: nestedPlugins } })).toEqual([
      { code: 'non_json_value', path: 'services[0]' },
      { code: 'non_json_value', path: 'routes[0]' },
      { code: 'non_json_value', path: 'plugins[0]' },
      { code: 'non_json_value', path: 'auth.endpoints[0]' },
      { code: 'non_json_value', path: 'auth.plugins[0]' },
    ]);
    expect(summary({
      plugins: [{ id: 'abcdefab-cdef-4abc-8def-abcdefabc101', name: 'x', options: { items: optionItems } }],
    })).toEqual([{ code: 'non_json_value', path: 'plugins[0].options.items[0]' }]);
  });

  test('rejects sparse arrays at every nested owner collection path', () => {
    const sparse = (): unknown[] => new Array<unknown>(1);
    expect(summary({
      services: [{
        id: '10000000-0000-4000-8000-000000000110', name: 'sparse',
        endpoints: sparse(), plugins: sparse(),
      }],
      routes: [{
        id: '20000000-0000-4000-8000-000000000110', path: '/sparse', plugins: sparse(),
        endpoints: [{
          id: '30000000-0000-4000-8000-000000000110', target: 'https://example.com', plugins: sparse(),
        }],
      }, {
        id: '20000000-0000-4000-8000-000000000111', path: '/sparse-endpoints', endpoints: sparse(),
      }],
    })).toEqual([
      { code: 'non_json_value', path: 'services[0].endpoints[0]' },
      { code: 'non_json_value', path: 'services[0].plugins[0]' },
      { code: 'non_json_value', path: 'routes[0].plugins[0]' },
      { code: 'non_json_value', path: 'routes[0].endpoints[0].plugins[0]' },
      { code: 'non_json_value', path: 'routes[1].endpoints[0]' },
    ]);
  });

  test('rejects symbol keys and accessors without invoking getters', () => {
    let getterCalls = 0;
    const nested: Record<PropertyKey, unknown> = { value: true };
    Object.defineProperty(nested, 'secret', {
      enumerable: true,
      get(): never {
        getterCalls += 1;
        throw new Error('must not run');
      },
    });
    const root: Record<PropertyKey, unknown> = { auth: nested };
    root[Symbol('root')] = true;
    nested[Symbol('nested')] = true;

    expect(summary(root)).toEqual([
      { code: 'non_json_value', path: '[Symbol(root)]' },
      { code: 'non_json_value', path: 'auth.secret' },
      { code: 'non_json_value', path: 'auth[Symbol(nested)]' },
    ]);
    expect(getterCalls).toBe(0);
  });

  test('returns deterministic errors for cyclic objects and arrays', () => {
    const auth: Record<string, unknown> = { enabled: false, tokens: [] };
    auth.self = auth;
    const cycle: unknown[] = [];
    cycle.push(cycle);
    expect(summary({ auth, plugins: [{ id: 'abcdefab-cdef-4abc-8def-abcdefabc102', name: 'x', options: { cycle } }] }))
      .toEqual([
        { code: 'non_json_value', path: 'auth.self' },
        { code: 'non_json_value', path: 'plugins[0].options.cycle[0]' },
      ]);
  });

  test('rejects every non-JSON scalar, prototype, number, and forbidden key before parsing', () => {
    class CustomValue { readonly value = true; }
    const forbidden = JSON.parse('{"__proto__":true,"constructor":{"prototype":true}}') as unknown;
    expect(summary({
      auth: {
        undefined: undefined,
        function: () => true,
        bigint: 1n,
        symbol: Symbol('value'),
        nan: Number.NaN,
        infinity: Number.POSITIVE_INFINITY,
        date: new Date(),
        map: new Map(),
        regex: /x/,
        custom: new CustomValue(),
        forbidden,
      },
    })).toEqual([
      { code: 'non_json_value', path: 'auth.undefined' },
      { code: 'non_json_value', path: 'auth.function' },
      { code: 'non_json_value', path: 'auth.bigint' },
      { code: 'non_json_value', path: 'auth.symbol' },
      { code: 'non_json_value', path: 'auth.nan' },
      { code: 'non_json_value', path: 'auth.infinity' },
      { code: 'non_json_value', path: 'auth.date' },
      { code: 'non_json_value', path: 'auth.map' },
      { code: 'non_json_value', path: 'auth.regex' },
      { code: 'non_json_value', path: 'auth.custom' },
      { code: 'forbidden_key', path: 'auth.forbidden.__proto__' },
      { code: 'forbidden_key', path: 'auth.forbidden.constructor' },
      { code: 'forbidden_key', path: 'auth.forbidden.constructor.prototype' },
    ]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test('rejects non-enumerable keys and reflection failures without throwing', () => {
    const hidden: Record<string, unknown> = {};
    Object.defineProperty(hidden, 'secret', { value: true, enumerable: false });
    const hostile = new Proxy({}, {
      ownKeys(): never { throw new Error('blocked'); },
    });
    expect(summary({ auth: hidden, logging: hostile })).toEqual([
      { code: 'non_json_value', path: 'auth.secret' },
      { code: 'non_json_value', path: 'logging' },
    ]);
  });

  test('rejects array named properties and array reflection failures', () => {
    const named: unknown[] = [];
    Object.defineProperty(named, 'extra', { value: true, enumerable: true });
    const hostile = new Proxy([], {
      getOwnPropertyDescriptor(_target, key): PropertyDescriptor | undefined {
        if (key === 'length') throw new Error('blocked');
        return undefined;
      },
    });
    expect(summary({ services: named, routes: hostile })).toEqual([
      { code: 'non_json_value', path: 'services.extra' },
      { code: 'non_json_value', path: 'routes' },
    ]);
  });

  test('rejects every non-canonical array index as a dotted property', () => {
    const routes: unknown[] = [];
    for (const key of ['4294967295', '9007199254740991', '01', '-1', 'named']) {
      Object.defineProperty(routes, key, { value: true, enumerable: true });
    }
    expect(summary({ routes })).toEqual([
      { code: 'non_json_value', path: 'routes.4294967295' },
      { code: 'non_json_value', path: 'routes.9007199254740991' },
      { code: 'non_json_value', path: 'routes.01' },
      { code: 'non_json_value', path: 'routes.-1' },
      { code: 'non_json_value', path: 'routes.named' },
    ]);
  });

  test('rejects a maximum-length sparse array from reflected indexes', () => {
    const routes: unknown[] = [];
    routes[4_294_967_294] = {};

    expect(summary({ routes })).toEqual([
      { code: 'non_json_value', path: 'routes[0]' },
    ]);
  });

  test('returns one deterministic error for revoked object and array proxies', () => {
    const rootObject = Proxy.revocable({}, {});
    const rootArray = Proxy.revocable([], {});
    const nestedObject = Proxy.revocable({}, {});
    const nestedArray = Proxy.revocable([], {});
    rootObject.revoke();
    rootArray.revoke();
    nestedObject.revoke();
    nestedArray.revoke();

    expect(summary(rootObject.proxy)).toEqual([{ code: 'non_json_value', path: '' }]);
    expect(summary(rootArray.proxy)).toEqual([{ code: 'non_json_value', path: '' }]);
    expect(summary({ auth: nestedObject.proxy, routes: nestedArray.proxy })).toEqual([
      { code: 'non_json_value', path: 'auth' },
      { code: 'non_json_value', path: 'routes' },
    ]);
  });

  test('handles object and array proxies revoked during reflection', () => {
    function revokeOnOwnKeys<T extends object>(target: T): T {
      let revoke = (): void => {};
      const revocable = Proxy.revocable(target, {
        ownKeys(): readonly (string | symbol)[] {
          revoke();
          return Reflect.ownKeys(target);
        },
      });
      revoke = revocable.revoke;
      return revocable.proxy;
    }

    expect(summary(revokeOnOwnKeys({}))).toEqual([{ code: 'non_json_value', path: '' }]);
    expect(summary(revokeOnOwnKeys([]))).toEqual([{ code: 'non_json_value', path: '' }]);
    expect(summary({
      auth: revokeOnOwnKeys({}),
      routes: revokeOnOwnKeys([]),
    })).toEqual([
      { code: 'non_json_value', path: 'auth' },
      { code: 'non_json_value', path: 'routes' },
    ]);
  });
});
