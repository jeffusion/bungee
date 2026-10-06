import { describe, expect, test } from 'bun:test';
import {
  RpcProtocolError,
  assertRpcData,
  decodeRpcJson,
  defineRpcService,
  encodeRpcJson,
  type InferRpcData,
  type RpcCallPurpose,
  type RpcDataSchema,
  type RpcMethodDefinition,
} from '../../src/plugin-services/wire-contract';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

const sampleSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1 },
    count: { type: 'number', integer: true, minimum: 0 },
    mode: { type: 'literal', value: 'fast' },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 4 },
    nested: { type: 'record', values: { type: 'boolean' }, maxEntries: 8 },
    choice: { type: 'union', variants: [{ type: 'null' }, { type: 'boolean' }] },
    blob: { type: 'json', maxBytes: 1024 },
  },
  optional: ['count', 'tags'],
} as const satisfies RpcDataSchema;

type Sample = InferRpcData<typeof sampleSchema>;

// Compile-time inference assertions (erased at runtime).
type _SampleName = Expect<Equal<Sample['name'], string>>;
type _SampleCount = Expect<Equal<Sample['count'], number | undefined>>;
type _SampleMode = Expect<Equal<Sample['mode'], 'fast'>>;
type _SampleTags = Expect<Equal<Sample['tags'], string[] | undefined>>;
type _SampleChoice = Expect<Equal<Sample['choice'], boolean | null>>;
type _SampleKeys = Expect<
  Equal<keyof Sample, 'name' | 'count' | 'mode' | 'tags' | 'nested' | 'choice' | 'blob'>
>;

// Optional keys must be genuinely optional: this literal omits `count` and `tags`.
const sampleWithoutOptional: Sample = { name: 'x', mode: 'fast', nested: {}, choice: null, blob: {} };
// @ts-expect-error literal schema keeps its literal type.
const sampleWrongMode: Sample = { name: 'x', mode: 'slow', nested: {}, choice: null, blob: {} };
// @ts-expect-error optional key type is still enforced when present.
const sampleWrongCount: Sample = { name: 'x', count: 'nope', nested: {}, choice: null, blob: {} };
void sampleWithoutOptional;
void sampleWrongMode;
void sampleWrongCount;

const typedContract = {
  id: 'example.plugin.service',
  version: 2,
  methods: {
    lookup: { kind: 'query', input: { type: 'string' }, output: { type: 'boolean' }, purposes: ['request'] },
    refresh: {
      kind: 'command',
      input: { type: 'object', properties: { id: { type: 'string' } } },
      output: { type: 'null' },
      purposes: ['management', 'attempt'],
      timeoutMs: 5000,
      maxOutputBytes: 4096,
      command: {
        deduplication: 'local-transaction',
        resultRetentionMs: 60000,
        quotaBytes: 8192,
        maxResultBytes: 4096,
      },
    },
  },
} as const;

type _LookupInput = Expect<Equal<InferRpcData<typeof typedContract.methods.lookup.input>, string>>;
type _LookupOutput = Expect<Equal<InferRpcData<typeof typedContract.methods.lookup.output>, boolean>>;
type _RefreshId = Expect<Equal<InferRpcData<typeof typedContract.methods.refresh.input>['id'], string>>;
type _RefreshKeys = Expect<Equal<keyof InferRpcData<typeof typedContract.methods.refresh.input>, 'id'>>;

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof RpcProtocolError ? error.code : `unexpected:${String(error)}`;
  }
}

function nest(depth: number): unknown {
  let value: unknown = 'leaf';
  for (let index = 0; index < depth; index += 1) value = [value];
  return value;
}

function defineRaw(contract: unknown): unknown {
  return defineRpcService(
    contract as { readonly id: string; readonly version: number; readonly methods: Record<string, RpcMethodDefinition> },
  );
}

function rawContract(methods: Record<string, unknown>): unknown {
  return { id: 'good.service', version: 1, methods };
}

const rawQuery = { kind: 'query', input: { type: 'string' }, output: { type: 'null' }, purposes: ['request'] };
const rawCommand = {
  kind: 'command',
  input: { type: 'string' },
  output: { type: 'null' },
  purposes: ['management'],
  command: { deduplication: 'none', resultRetentionMs: null, quotaBytes: 2048, maxResultBytes: 1024 },
};

describe('encodeRpcJson', () => {
  test('round-trips JSON null and primitives', () => {
    expect(encodeRpcJson(null)).toBe('null');
    expect(encodeRpcJson(true)).toBe('true');
    expect(encodeRpcJson(3)).toBe('3');
    expect(encodeRpcJson('x')).toBe('"x"');
    expect(decodeRpcJson('null')).toBeNull();
  });

  test('measures the UTF-8 byte limit, not the JavaScript string length', () => {
    expect(encodeRpcJson('😀', 6)).toBe('"😀"');
    expect(codeOf(() => encodeRpcJson('😀', 5))).toBe('size_limit');
    expect(encodeRpcJson('a'.repeat(3), 5)).toBe('"aaa"');
    expect(codeOf(() => encodeRpcJson('a'.repeat(4), 5))).toBe('size_limit');
  });

  test('allows an explicit larger byte bound for an independent data channel', () => {
    const large = 'a'.repeat(70 * 1024);
    expect(encodeRpcJson(large, 80 * 1024).length).toBe(large.length + 2);
    expect(codeOf(() => encodeRpcJson(large))).toBe('size_limit');
  });

  test('inspects descriptors and never reads accessors', () => {
    let reads = 0;
    const withGetter = {
      get value() {
        reads += 1;
        return 1;
      },
    };
    expect(codeOf(() => encodeRpcJson(withGetter))).toBe('invalid_data');
    expect(reads).toBe(0);

    const hidden = Object.defineProperty({}, 'x', { value: 1, enumerable: false });
    expect(codeOf(() => encodeRpcJson(hidden))).toBe('invalid_data');

    const withToJson = { toJSON: () => 'changed' };
    expect(codeOf(() => encodeRpcJson(withToJson))).toBe('invalid_data');
  });

  test('rejects non-plain objects such as Date and Response', () => {
    expect(codeOf(() => encodeRpcJson(new Date(0)))).toBe('invalid_data');
    expect(codeOf(() => encodeRpcJson(new Response('ok')))).toBe('invalid_data');
    expect(codeOf(() => encodeRpcJson(new Map()))).toBe('invalid_data');
  });

  test('rejects cycles, holes, undefined, non-finite numbers, bigint, functions, and symbols', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(codeOf(() => encodeRpcJson(cyclic))).toBe('invalid_data');

    const sparse = [1, , 3] as unknown[];
    expect(codeOf(() => encodeRpcJson(sparse))).toBe('invalid_data');
    const grown: unknown[] = [1, 2];
    grown.length = 3;
    expect(codeOf(() => encodeRpcJson(grown))).toBe('invalid_data');
    expect(codeOf(() => encodeRpcJson([undefined]))).toBe('invalid_data');
    expect(codeOf(() => encodeRpcJson({ a: undefined }))).toBe('invalid_data');
    expect(codeOf(() => encodeRpcJson(undefined))).toBe('invalid_data');
    expect(codeOf(() => encodeRpcJson(Number.NaN))).toBe('invalid_data');
    expect(codeOf(() => encodeRpcJson(Number.POSITIVE_INFINITY))).toBe('invalid_data');
    expect(codeOf(() => encodeRpcJson(1n))).toBe('invalid_data');
    expect(codeOf(() => encodeRpcJson(() => 1))).toBe('invalid_data');
    expect(codeOf(() => encodeRpcJson(Symbol('s')))).toBe('invalid_data');
    expect(codeOf(() => encodeRpcJson({ [Symbol('s')]: 1 }))).toBe('invalid_data');
    expect(codeOf(() => encodeRpcJson('\uD800'))).toBe('invalid_data');
  });

  test('enforces the 64-container depth bound', () => {
    expect(() => encodeRpcJson(nest(64))).not.toThrow();
    expect(codeOf(() => encodeRpcJson(nest(65)))).toBe('invalid_data');
  });

  test('allows null-prototype records and never pollutes __proto__', () => {
    const nullPrototype = Object.create(null) as Record<string, unknown>;
    nullPrototype.value = 3;
    expect(encodeRpcJson(nullPrototype)).toBe('{"value":3}');

    const polluted = JSON.parse('{"__proto__":{"polluted":true},"safe":1}');
    const text = encodeRpcJson(polluted);
    expect(text).toContain('__proto__');
    const decoded = decodeRpcJson(text);
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(decoded, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test('does not leak the offending value into the error message', () => {
    try {
      encodeRpcJson({ token: 'super-secret', bad: undefined });
      throw new Error('expected encodeRpcJson to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(RpcProtocolError);
      expect((error as RpcProtocolError).code).toBe('invalid_data');
      expect((error as Error).message).not.toContain('super-secret');
    }
  });
});

describe('decodeRpcJson', () => {
  test('parses and re-encodes canonical JSON', () => {
    const text = '{"a":1,"b":[true,null,"x"]}';
    const decoded = decodeRpcJson(text);
    expect(decoded).toEqual({ a: 1, b: [true, null, 'x'] });
    expect(encodeRpcJson(decoded)).toBe(text);
  });

  test('rejects syntax errors, duplicate keys, trailing content, and empty input', () => {
    expect(codeOf(() => decodeRpcJson('{'))).toBe('invalid_data');
    expect(codeOf(() => decodeRpcJson('{"a":1,}'))).toBe('invalid_data');
    expect(codeOf(() => decodeRpcJson('{"a":1,"a":2}'))).toBe('invalid_data');
    expect(codeOf(() => decodeRpcJson('1 2'))).toBe('invalid_data');
    expect(codeOf(() => decodeRpcJson('01'))).toBe('invalid_data');
    expect(codeOf(() => decodeRpcJson(''))).toBe('invalid_data');
  });

  test('rejects non-finite numbers and lone surrogates', () => {
    expect(codeOf(() => decodeRpcJson('1e999'))).toBe('invalid_data');
    expect(codeOf(() => decodeRpcJson('{"a":-1e999}'))).toBe('invalid_data');
    expect(codeOf(() => decodeRpcJson('"\\ud800"'))).toBe('invalid_data');
  });

  test('enforces byte and depth bounds', () => {
    expect(decodeRpcJson('"😀"', 6)).toBe('😀');
    expect(codeOf(() => decodeRpcJson('"😀"', 5))).toBe('size_limit');
    expect(() => decodeRpcJson(JSON.stringify(nest(64)))).not.toThrow();
    expect(codeOf(() => decodeRpcJson(JSON.stringify(nest(65))))).toBe('invalid_data');
  });
});

describe('assertRpcData', () => {
  const userSchema = {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1 },
      nickname: { type: 'string', maxLength: 8 },
    },
    optional: ['nickname'],
  } as const satisfies RpcDataSchema;

  test('accepts required and optional keys and narrows the value type', () => {
    expect(codeOf(() => { assertRpcData(userSchema, { id: 'a' }); })).toBeUndefined();
    expect(codeOf(() => { assertRpcData(userSchema, { id: 'a', nickname: 'bb' }); })).toBeUndefined();
    const candidate: unknown = { id: 'a', nickname: 'bb' };
    assertRpcData(userSchema, candidate);
    const narrowed: { id: string; nickname?: string } = candidate;
    expect(narrowed.id).toBe('a');
  });

  test('an independent data channel can explicitly bound a larger structured payload', () => {
    const schema = { type: 'record', values: { type: 'string' } } as const;
    const data = { content: 'a'.repeat(70 * 1024) };
    expect(codeOf(() => assertRpcData(schema, data))).toBe('invalid_data');
    expect(codeOf(() => assertRpcData(schema, data, 128 * 1024))).toBeUndefined();
  });

  test('byte limits include exact numeric text and JSON escaping, not only the lower bound', () => {
    expect(codeOf(() => assertRpcData({ type: 'number' }, 100000, 5))).toBe('invalid_data');
    expect(codeOf(() => assertRpcData({ type: 'number' }, 100000, 6))).toBeUndefined();
    const schema = { type: 'object', properties: { text: { type: 'string' } } } as const;
    expect(codeOf(() => assertRpcData(schema, { text: '\n'.repeat(40 * 1024) }))).toBe('invalid_data');
    expect(codeOf(() => defineRpcService({ id: 'escaped', version: 1, methods: { read: { kind: 'query', input: { type: 'literal', value: '\n'.repeat(140 * 1024) }, output: { type: 'null' }, purposes: ['background'] } } }))).toBe('invalid_contract');
  });

  test('rejects unknown fields and missing required fields', () => {
    expect(codeOf(() => { assertRpcData(userSchema, { id: 'a', extra: 1 }); })).toBe('invalid_data');
    expect(codeOf(() => { assertRpcData(userSchema, { nickname: 'b' }); })).toBe('invalid_data');
    expect(codeOf(() => { assertRpcData(userSchema, 'x'); })).toBe('invalid_data');
    expect(codeOf(() => { assertRpcData(userSchema, { id: '' }); })).toBe('invalid_data');
    expect(codeOf(() => { assertRpcData(userSchema, { id: 'a', nickname: 'way-too-long' }); })).toBe('invalid_data');
  });

  test('validates arrays, records, unions, literals, and bounded JSON', () => {
    const arraySchema = { type: 'array', items: { type: 'number', integer: true }, maxItems: 2 } as const satisfies RpcDataSchema;
    expect(codeOf(() => { assertRpcData(arraySchema, [1, 2]); })).toBeUndefined();
    expect(codeOf(() => { assertRpcData(arraySchema, [1, 2, 3]); })).toBe('invalid_data');
    expect(codeOf(() => { assertRpcData(arraySchema, [1, 1.5]); })).toBe('invalid_data');

    const recordSchema = { type: 'record', values: { type: 'boolean' }, maxEntries: 2 } as const satisfies RpcDataSchema;
    expect(codeOf(() => { assertRpcData(recordSchema, { a: true }); })).toBeUndefined();
    expect(codeOf(() => { assertRpcData(recordSchema, { a: true, b: false, c: true }); })).toBe('invalid_data');
    expect(codeOf(() => { assertRpcData(recordSchema, { a: 1 }); })).toBe('invalid_data');

    const unionSchema = { type: 'union', variants: [{ type: 'null' }, { type: 'boolean' }] } as const satisfies RpcDataSchema;
    expect(codeOf(() => { assertRpcData(unionSchema, null); })).toBeUndefined();
    expect(codeOf(() => { assertRpcData(unionSchema, true); })).toBeUndefined();
    expect(codeOf(() => { assertRpcData(unionSchema, 1); })).toBe('invalid_data');

    const literalSchema = { type: 'literal', value: 'fast' } as const satisfies RpcDataSchema;
    expect(codeOf(() => { assertRpcData(literalSchema, 'fast'); })).toBeUndefined();
    expect(codeOf(() => { assertRpcData(literalSchema, 'slow'); })).toBe('invalid_data');

    const jsonSchema = { type: 'json', maxBytes: 16 } as const satisfies RpcDataSchema;
    expect(codeOf(() => { assertRpcData(jsonSchema, { a: 1 }); })).toBeUndefined();
    expect(codeOf(() => { assertRpcData(jsonSchema, { a: 1, b: 2, c: 3, d: 4 }); })).toBe('invalid_data');
    expect(codeOf(() => { assertRpcData(jsonSchema, undefined); })).toBe('invalid_data');

    const unboundedJsonSchema = { type: 'json' } as const satisfies RpcDataSchema;
    expect(codeOf(() => { assertRpcData(unboundedJsonSchema, { a: 1 }); })).toBeUndefined();
    expect(codeOf(() => { assertRpcData(unboundedJsonSchema, 'a'.repeat(70 * 1024)); })).toBe('invalid_data');
  });

  test('rejects a malformed schema itself', () => {
    expect(
      codeOf(() => {
        assertRpcData({ type: 'string', minLength: 5, maxLength: 1 } as RpcDataSchema, 'x');
      }),
    ).toBe('invalid_contract');
  });
});

describe('defineRpcService', () => {
  test('freezes a validated clone without freezing the caller', () => {
    const service = defineRpcService(typedContract);
    expect(service.id).toBe('example.plugin.service');
    expect(service.version).toBe(2);
    expect(Object.isFrozen(service)).toBe(true);
    expect(Object.isFrozen(service.methods)).toBe(true);
    expect(Object.isFrozen(service.methods.refresh)).toBe(true);
    expect(Object.isFrozen(service.methods.refresh.purposes)).toBe(true);
    expect(Object.isFrozen(service.methods.refresh.input)).toBe(true);
    expect(Object.isFrozen(service.methods.refresh.command)).toBe(true);
    expect(Object.isFrozen(typedContract)).toBe(false);
    expect(Object.isFrozen(typedContract.methods.refresh)).toBe(false);
  });

  test('isolates the contract from later mutations of the caller objects', () => {
    const mutable = {
      id: 'mutable.service',
      version: 1,
      methods: {
        m: {
          kind: 'query' as const,
          input: { type: 'string' as const },
          output: { type: 'null' as const },
          purposes: ['request'] as RpcCallPurpose[],
        },
      },
    };
    const service = defineRpcService(mutable);
    mutable.methods.m.purposes.push('attempt');
    expect(service.methods.m.purposes).toEqual(['request']);
    expect(Object.isFrozen(service.methods.m.purposes)).toBe(true);
  });

  test('rejects invalid ids, versions, and method names', () => {
    expect(codeOf(() => defineRaw({ id: 'Bad', version: 1, methods: {} }))).toBe('invalid_contract');
    expect(codeOf(() => defineRaw({ id: '1bad', version: 1, methods: {} }))).toBe('invalid_contract');
    expect(codeOf(() => defineRaw({ id: 'good.service', version: 0, methods: {} }))).toBe('invalid_contract');
    expect(codeOf(() => defineRaw({ id: 'good.service', version: 1.5, methods: {} }))).toBe('invalid_contract');
    expect(codeOf(() => defineRaw(rawContract({ '1bad': rawQuery })))).toBe('invalid_contract');
    expect(codeOf(() => defineRaw(rawContract({ ['a'.repeat(129)]: rawQuery })))).toBe('invalid_contract');
  });

  test('rejects invalid purposes and timeouts', () => {
    expect(codeOf(() => defineRaw(rawContract({ m: { ...rawQuery, purposes: [] } })))).toBe('invalid_contract');
    expect(codeOf(() => defineRaw(rawContract({ m: { ...rawQuery, purposes: ['request', 'request'] } })))).toBe(
      'invalid_contract',
    );
    expect(codeOf(() => defineRaw(rawContract({ m: { ...rawQuery, purposes: ['nope'] } })))).toBe('invalid_contract');
    for (const timeoutMs of [0, -1, 1.5, 300001]) {
      expect(codeOf(() => defineRaw(rawContract({ m: { ...rawQuery, timeoutMs } })))).toBe('invalid_contract');
    }
    expect(codeOf(() => defineRaw(rawContract({ m: { ...rawQuery, timeoutMs: 300000 } })))).toBeUndefined();
  });

  test('rejects invalid byte limits', () => {
    for (const maxInputBytes of [0, -1, 65537]) {
      expect(codeOf(() => defineRaw(rawContract({ m: { ...rawQuery, maxInputBytes } })))).toBe('invalid_contract');
    }
    expect(codeOf(() => defineRaw(rawContract({ m: { ...rawQuery, maxOutputBytes: 65536 } })))).toBeUndefined();
  });

  test('enforces command policy presence and shape', () => {
    expect(codeOf(() => defineRaw(rawContract({ m: { ...rawQuery, command: rawCommand.command } })))).toBe(
      'invalid_contract',
    );
    expect(codeOf(() => defineRaw(rawContract({ m: { kind: 'command', input: rawQuery.input, output: rawQuery.output, purposes: ['management'] } })))).toBe(
      'invalid_contract',
    );
    expect(
      codeOf(() =>
        defineRaw(
          rawContract({
            m: {
              ...rawCommand,
              command: { deduplication: 'external-contract', resultRetentionMs: null, quotaBytes: 2048, maxResultBytes: 1024 },
            },
          }),
        ),
      ),
    ).toBeUndefined();
    expect(
      codeOf(() =>
        defineRaw(
          rawContract({
            m: { ...rawCommand, command: { deduplication: 'bogus', resultRetentionMs: null, quotaBytes: 1, maxResultBytes: 1 } },
          }),
        ),
      ),
    ).toBe('invalid_contract');
    expect(
      codeOf(() =>
        defineRaw(
          rawContract({
            m: { ...rawCommand, command: { deduplication: 'none', resultRetentionMs: 0, quotaBytes: 2048, maxResultBytes: 1024 } },
          }),
        ),
      ),
    ).toBe('invalid_contract');
    expect(
      codeOf(() =>
        defineRaw(
          rawContract({
            m: { ...rawCommand, command: { deduplication: 'none', resultRetentionMs: null, quotaBytes: 1024, maxResultBytes: 2048 } },
          }),
        ),
      ),
    ).toBe('invalid_contract');
    expect(
      codeOf(() =>
        defineRaw(
          rawContract({
            m: {
              ...rawCommand,
              maxOutputBytes: 1024,
              command: { deduplication: 'none', resultRetentionMs: null, quotaBytes: 4096, maxResultBytes: 2048 },
            },
          }),
        ),
      ),
    ).toBe('invalid_contract');
    expect(
      codeOf(() =>
        defineRaw(
          rawContract({
            m: {
              ...rawCommand,
              command: { deduplication: 'none', resultRetentionMs: null, quotaBytes: 2048, maxResultBytes: 1024, extra: 1 },
            },
          }),
        ),
      ),
    ).toBe('invalid_contract');
    expect(
      codeOf(() =>
        defineRaw(
          rawContract({
            m: { ...rawCommand, command: { deduplication: 'none', resultRetentionMs: null, quotaBytes: 2048, maxResultBytes: 65537 } },
          }),
        ),
      ),
    ).toBe('invalid_contract');
  });

  test('rejects illegal schemas, including cycles and bad json bounds', () => {
    const base = { kind: 'query', output: { type: 'null' }, purposes: ['request'] };
    expect(codeOf(() => defineRaw(rawContract({ m: { ...base, input: { type: 'bogus' } } })))).toBe('invalid_contract');
    expect(codeOf(() => defineRaw(rawContract({ m: { ...base, input: { type: 'string', minLength: 5, maxLength: 1 } } })))).toBe(
      'invalid_contract',
    );
    expect(
      codeOf(() =>
        defineRaw(rawContract({ m: { ...base, input: { type: 'object', properties: { a: { type: 'string' } }, optional: ['b'] } } })),
      ),
    ).toBe('invalid_contract');
    expect(codeOf(() => defineRaw(rawContract({ m: { ...base, input: { type: 'json', maxBytes: 0 } } })))).toBe(
      'invalid_contract',
    );
    expect(codeOf(() => defineRaw(rawContract({ m: { ...base, input: { type: 'json' } } })))).toBeUndefined();

    const cyclic: Record<string, unknown> = { type: 'array' };
    cyclic.items = cyclic;
    expect(codeOf(() => defineRaw(rawContract({ m: { ...base, input: cyclic } })))).toBe('invalid_contract');
  });
});

describe('wire-contract hardening', () => {
  const objectSchema = {
    type: 'object',
    properties: { id: { type: 'string' } },
    optional: [],
  } as const satisfies RpcDataSchema;
  const jsonSchema = { type: 'json' } as const satisfies RpcDataSchema;

  test('assertRpcData rejects impure values without reading accessors', () => {
    let reads = 0;
    const accessor = {
      get id() {
        reads += 1;
        return 'a';
      },
    };
    expect(codeOf(() => { assertRpcData(objectSchema, accessor); })).toBe('invalid_data');
    expect(reads).toBe(0);

    const hidden = Object.defineProperty({}, 'id', { value: 'a', enumerable: false });
    expect(codeOf(() => { assertRpcData(objectSchema, hidden); })).toBe('invalid_data');
    expect(codeOf(() => { assertRpcData(objectSchema, { id: 'a', [Symbol('s')]: 1 }); })).toBe('invalid_data');
    expect(codeOf(() => { assertRpcData(jsonSchema, new Date(0)); })).toBe('invalid_data');
    expect(codeOf(() => { assertRpcData(jsonSchema, () => 1); })).toBe('invalid_data');
  });

  test('assertRpcData bounds runtime depth and honours an explicit larger json bound', () => {
    expect(codeOf(() => { assertRpcData(jsonSchema, nest(64)); })).toBeUndefined();
    expect(codeOf(() => { assertRpcData(jsonSchema, nest(65)); })).toBe('invalid_data');

    const large = 'a'.repeat(70 * 1024);
    const bounded = { type: 'json', maxBytes: 200 * 1024 } as const satisfies RpcDataSchema;
    expect(codeOf(() => { assertRpcData(bounded, large); })).toBeUndefined();
    expect(codeOf(() => { assertRpcData(jsonSchema, large); })).toBe('invalid_data');
  });

  test('invalid_data messages never include user keys', () => {
    try {
      assertRpcData(objectSchema, { id: 'a', ['top-secret-field']: 1 });
      throw new Error('expected assertRpcData to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(RpcProtocolError);
      expect((error as RpcProtocolError).code).toBe('invalid_data');
      expect((error as Error).message).not.toContain('top-secret-field');
    }
    try {
      encodeRpcJson({ ['super-secret-key']: undefined });
      throw new Error('expected encodeRpcJson to throw');
    } catch (error) {
      expect((error as Error).message).not.toContain('super-secret-key');
    }
  });

  test('rejects unknown contract, method, and schema fields', () => {
    expect(codeOf(() => defineRaw({ id: 'good.service', version: 1, methods: { m: rawQuery }, rollback: true }))).toBe(
      'invalid_contract',
    );
    expect(
      codeOf(() => defineRaw({ id: 'good.service', version: 1, methods: { m: { ...rawQuery, autoRetry: 3 } } })),
    ).toBe('invalid_contract');
    expect(
      codeOf(() =>
        defineRaw({ id: 'good.service', version: 1, methods: { m: { ...rawQuery, input: { type: 'string', autoRetry: 1 } } } }),
      ),
    ).toBe('invalid_contract');
  });

  test('requires a non-empty bounded method set', () => {
    expect(codeOf(() => defineRaw({ id: 'good.service', version: 1, methods: {} }))).toBe('invalid_contract');
    const many: Record<string, unknown> = {};
    for (let index = 0; index < 129; index += 1) many[`method${index}`] = rawQuery;
    expect(codeOf(() => defineRaw(rawContract(many)))).toBe('invalid_contract');
  });

  test('literal distinguishes arrays from records', () => {
    const recordLiteral = { type: 'literal', value: { '0': 'x' } } as const satisfies RpcDataSchema;
    expect(codeOf(() => { assertRpcData(recordLiteral, { '0': 'x' }); })).toBeUndefined();
    expect(codeOf(() => { assertRpcData(recordLiteral, ['x']); })).toBe('invalid_data');

    const arrayLiteral = { type: 'literal', value: ['x'] } as const satisfies RpcDataSchema;
    expect(codeOf(() => { assertRpcData(arrayLiteral, ['x']); })).toBeUndefined();
    expect(codeOf(() => { assertRpcData(arrayLiteral, { '0': 'x' }); })).toBe('invalid_data');
  });

  test('rejects oversized input before cloning or stringifying the whole value', () => {
    const huge = 'a'.repeat(1024 * 1024);
    expect(codeOf(() => encodeRpcJson(huge))).toBe('size_limit');
    expect(encodeRpcJson(huge, 2 * 1024 * 1024).length).toBe(huge.length + 2);

    const manyItems = new Array(70 * 1024).fill(0) as unknown[];
    expect(codeOf(() => encodeRpcJson(manyItems))).toBe('size_limit');
  });

  test('does not invoke accessors while cloning contracts or schemas', () => {
    let contractReads = 0;
    const contract = {
      id: 'good.service',
      version: 1,
      get methods() {
        contractReads += 1;
        return { m: rawQuery };
      },
    };
    expect(codeOf(() => defineRaw(contract))).toBe('invalid_contract');
    expect(contractReads).toBe(0);

    let methodReads = 0;
    const definition = {
      kind: 'query',
      input: { type: 'string' },
      output: { type: 'null' },
      purposes: ['request'],
      get timeoutMs() {
        methodReads += 1;
        return 1;
      },
    };
    expect(codeOf(() => defineRaw(rawContract({ m: definition })))).toBe('invalid_contract');
    expect(methodReads).toBe(0);

    let schemaReads = 0;
    const schema = {
      type: 'object',
      get properties() {
        schemaReads += 1;
        return { id: { type: 'string' } };
      },
      optional: [],
    };
    expect(codeOf(() => { assertRpcData(schema as unknown as RpcDataSchema, { id: 'a' }); })).toBe('invalid_contract');
    expect(schemaReads).toBe(0);
  });

  test('accepts null command result retention as permanent durable retention', () => {
    expect(
      codeOf(() =>
        defineRaw(
          rawContract({
            m: {
              ...rawCommand,
              command: { deduplication: 'local-transaction', resultRetentionMs: null, quotaBytes: 2048, maxResultBytes: 1024 },
            },
          }),
        ),
      ),
    ).toBeUndefined();
  });
});
