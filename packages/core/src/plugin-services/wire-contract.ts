/**
 * Plugin service RPC data contract (P1/P4): a dependency-free schema DSL, a
 * bounded strict-JSON codec, and service/method contract validation.
 *
 * Scope boundary: this module validates *data shapes only*. It deliberately
 * grants no wire authorization — host identity, generation, scope/lease, call
 * context, and permissions must be enforced by the host RPC adapter, never by a
 * schema check here. In particular `command.deduplication` is a declared intent;
 * real local transactions and any cross-system exactly-once behavior belong to
 * the host and to the external contract, not to this file.
 *
 * Everything that reaches validation is first cloned from own property
 * descriptors into bounded pure JSON, so no getter, proxy trap, or `toJSON` is
 * ever invoked and no non-JSON shape is silently accepted.
 */
import { isProxy } from 'node:util/types';

export type RpcCallKind = 'query' | 'command';
export type RpcCallPurpose = 'bootstrap' | 'background' | 'management' | 'request' | 'attempt';
export type RpcCommandDeduplication = 'local-transaction' | 'external-contract' | 'none';

/** Declared intent only; the host owns the actual transaction and retention. */
export interface RpcCommandPolicy {
  readonly deduplication: RpcCommandDeduplication;
  /**
   * `null` means the result is retained permanently and durably: it survives a
   * restart and is never recomputed. A positive number is a retention window in
   * milliseconds. Retention is a host/storage concern; this is declaration only.
   */
  readonly resultRetentionMs: number | null;
  readonly quotaBytes: number;
  readonly maxResultBytes: number;
}

/** Pure JSON: null, boolean, finite number, string, arrays, and plain records. */
export type RpcJson =
  | null
  | boolean
  | number
  | string
  | readonly RpcJson[]
  | { readonly [key: string]: RpcJson };

/**
 * Data schema DSL. `object` rejects unknown fields, `optional` lists real
 * optional keys, and `json` carries an optional explicit byte bound (default:
 * the RPC envelope).
 */
export type RpcDataSchema =
  | { readonly type: 'string'; readonly minLength?: number; readonly maxLength?: number }
  | { readonly type: 'number'; readonly integer?: boolean; readonly minimum?: number; readonly maximum?: number }
  | { readonly type: 'boolean' }
  | { readonly type: 'null' }
  | { readonly type: 'literal'; readonly value: RpcJson }
  | { readonly type: 'array'; readonly items: RpcDataSchema; readonly maxItems?: number }
  | {
      readonly type: 'object';
      readonly properties: { readonly [key: string]: RpcDataSchema };
      readonly optional?: readonly string[];
    }
  | { readonly type: 'record'; readonly values: RpcDataSchema; readonly maxEntries?: number }
  | { readonly type: 'union'; readonly variants: readonly RpcDataSchema[] }
  | { readonly type: 'json'; readonly maxBytes?: number };

/** Flattens intersections so optional modifiers survive as real optional keys. */
type Simplify<T> = { [K in keyof T]: T[K] };

type OptionalNames<S> = S extends { readonly optional: readonly (infer K extends string)[] } ? K : never;

type InferObject<P extends Record<string, RpcDataSchema>, O extends string> = Simplify<
  { [K in keyof P as K extends O ? never : K]: InferRpcData<P[K]> } &
  { [K in Extract<keyof P, O>]?: InferRpcData<P[K]> }
>;

/** Derives the TypeScript type described by a `RpcDataSchema`. */
export type InferRpcData<S> =
  RpcDataSchema extends S ? RpcJson : S extends { readonly type: 'string' }
    ? string
    : S extends { readonly type: 'number' }
      ? number
      : S extends { readonly type: 'boolean' }
        ? boolean
        : S extends { readonly type: 'null' }
          ? null
          : S extends { readonly type: 'literal'; readonly value: infer V extends RpcJson }
            ? V
            : S extends { readonly type: 'json' }
              ? RpcJson
              : S extends { readonly type: 'array'; readonly items: infer I extends RpcDataSchema }
                ? InferRpcData<I>[]
                : S extends { readonly type: 'record'; readonly values: infer V extends RpcDataSchema }
                  ? { [key: string]: InferRpcData<V> }
                  : S extends { readonly type: 'union'; readonly variants: infer VS }
                    ? VS extends readonly (infer V extends RpcDataSchema)[]
                      ? InferRpcData<V>
                      : never
                    : S extends { readonly type: 'object'; readonly properties: infer P extends Record<string, RpcDataSchema> }
                      ? InferObject<P, OptionalNames<S>>
                      : never;

export interface RpcMethodDefinition {
  readonly kind: RpcCallKind;
  readonly input: RpcDataSchema;
  readonly output: RpcDataSchema;
  readonly purposes: readonly RpcCallPurpose[];
  readonly timeoutMs?: number;
  readonly maxInputBytes?: number;
  readonly maxOutputBytes?: number;
  readonly command?: RpcCommandPolicy;
}

export interface RpcServiceContract<
  M extends Record<string, RpcMethodDefinition> = Record<string, RpcMethodDefinition>,
> {
  readonly id: string;
  readonly version: number;
  readonly methods: M;
}

export const RPC_JSON_MAX_BYTES = 64 * 1024;
/** Metadata contract/schema inputs are pure JSON and bounded well below the envelope. */
export const RPC_CONTRACT_MAX_BYTES = 256 * 1024;

const JSON_MAX_DEPTH = 64;
const SCHEMA_MAX_DEPTH = 64;
const RPC_MAX_TIMEOUT_MS = 300_000;
const RPC_MAX_METHODS = 128;
const RPC_SERVICE_ID = /^[a-z][a-z0-9.-]{0,127}$/;
const RPC_METHOD_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
const RPC_CALL_PURPOSES = new Set<RpcCallPurpose>(['bootstrap', 'background', 'management', 'request', 'attempt']);
const RPC_COMMAND_DEDUPLICATION = new Set<RpcCommandDeduplication>(['local-transaction', 'external-contract', 'none']);
const RPC_COMMAND_POLICY_KEYS = new Set(['deduplication', 'resultRetentionMs', 'quotaBytes', 'maxResultBytes']);
const CONTRACT_KEYS = ['id', 'version', 'methods'] as const;
const METHOD_KEYS = [
  'kind',
  'input',
  'output',
  'purposes',
  'timeoutMs',
  'maxInputBytes',
  'maxOutputBytes',
  'command',
] as const;

export type RpcProtocolErrorCode = 'invalid_data' | 'size_limit' | 'invalid_contract';

/** Fixed-code error. It never carries payload, secrets, keys, or arbitrary objects. */
export class RpcProtocolError extends Error {
  readonly name = 'RpcProtocolError';

  constructor(
    readonly code: RpcProtocolErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Reports a fixed schema category only — never a user property name or value. */
function failData(category: string): never {
  throw new RpcProtocolError('invalid_data', `invalid_data in ${category}`);
}

function failSize(): never {
  throw new RpcProtocolError('size_limit', 'size_limit: JSON value exceeds the byte limit');
}

function failContract(reason: string): never {
  throw new RpcProtocolError('invalid_contract', `invalid_contract: ${reason}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  if (isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isArrayIndex(key: string, length: number): boolean {
  if (!/^(?:0|[1-9]\d*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length;
}

function assertKnownKeys(input: Record<string, unknown>, allowed: readonly string[], category: string): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) failContract(`unknown ${category} field`);
  }
}

/**
 * Running lower bound of the JSON byte size, used to reject oversized input
 * before it is fully cloned or stringified. Every accounting term is an
 * underestimate (escapes only ever add bytes), so a positive budget never
 * rejects a value that would actually fit.
 */
interface SnapshotBudget {
  left: number;
}

function spend(budget: SnapshotBudget, bytes: number): void {
  budget.left -= bytes;
  if (budget.left < 0) failSize();
}

/**
 * Validates and deep-clones a value into a plain pure-JSON graph. Object
 * descriptors are inspected before any value is read, so accessors and `toJSON`
 * are never invoked. Cycles, holes, non-plain objects, non-enumerable or symbol
 * keys, non-finite numbers, lone surrogates, and over-deep nesting are rejected;
 * the budget rejects oversized values early.
 */
function snapshot(value: unknown, depth: number, ancestors: Set<object>, budget: SnapshotBudget): RpcJson {
  if (value === null) {
    spend(budget, 4);
    return null;
  }
  if (typeof value === 'boolean') {
    spend(budget, value ? 4 : 5);
    return value;
  }
  if (typeof value === 'string') {
    if (hasLoneSurrogate(value)) failData('string');
    spend(budget, Buffer.byteLength(value, 'utf8') + 2);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) failData('number');
    spend(budget, 1);
    return value;
  }
  if (typeof value !== 'object') failData('json');
  const object = value as object;
  if (isProxy(object)) failData('json');
  if (ancestors.has(object)) failData('json');
  const nextDepth = depth + 1;
  if (nextDepth > JSON_MAX_DEPTH) failData('json');
  if (Array.isArray(object)) {
    if (Object.getPrototypeOf(object) !== Array.prototype) failData('array');
    const lengthDescriptor = Object.getOwnPropertyDescriptor(object, 'length');
    if (!lengthDescriptor || !('value' in lengthDescriptor) || typeof lengthDescriptor.value !== 'number') {
      failData('array');
    }
    const length = lengthDescriptor.value;
    if (!Number.isSafeInteger(length) || length < 0) failData('array');
    if (length > budget.left) failSize();
    spend(budget, 2);
    if (length > 1) spend(budget, length - 1);
    ancestors.add(object);
    const items: RpcJson[] = new Array(length);
    let count = 0;
    for (const key of Reflect.ownKeys(object)) {
      if (key === 'length') continue;
      if (typeof key !== 'string' || !isArrayIndex(key, length)) failData('array');
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) failData('array');
      items[Number(key)] = snapshot(descriptor.value, nextDepth, ancestors, budget);
      count += 1;
    }
    if (count !== length) failData('array');
    ancestors.delete(object);
    return items;
  }
  const prototype = Object.getPrototypeOf(object);
  if (prototype !== Object.prototype && prototype !== null) failData('object');
  const keys = Reflect.ownKeys(object);
  if (keys.length > budget.left) failSize();
  spend(budget, 2);
  if (keys.length > 1) spend(budget, keys.length - 1);
  ancestors.add(object);
  const result: Record<string, RpcJson> = {};
  for (const key of keys) {
    if (typeof key !== 'string') failData('object');
    if (hasLoneSurrogate(key)) failData('object');
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) failData('object');
    spend(budget, Buffer.byteLength(key, 'utf8') + 3);
    // defineProperty keeps a literal `__proto__` key an own data property instead of polluting the prototype.
    Object.defineProperty(result, key, {
      value: snapshot(descriptor.value, nextDepth, ancestors, budget),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  ancestors.delete(object);
  return result;
}

/** Clones a contract/schema input as bounded pure JSON, mapping pure-JSON errors to invalid_contract. */
function snapshotPureInput(input: unknown): RpcJson {
  try {
    const pure = snapshot(input, 0, new Set(), { left: RPC_CONTRACT_MAX_BYTES });
    if (Buffer.byteLength(JSON.stringify(pure), 'utf8') > RPC_CONTRACT_MAX_BYTES) failContract('input must be bounded pure JSON data');
    return pure;
  } catch (error) {
    if (error instanceof RpcProtocolError && (error.code === 'invalid_data' || error.code === 'size_limit')) {
      failContract('input must be bounded pure JSON data');
    }
    throw error;
  }
}

/** Strict scanner: rejects duplicate keys, trailing content, and deep nesting. */
function scanJson(text: string): void {
  let index = 0;
  const numberPattern = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const fail = (): never => {
    throw new RpcProtocolError('invalid_data', 'invalid JSON text');
  };
  const whitespace = (): void => {
    while (index < text.length) {
      const character = text[index];
      if (character === ' ' || character === '\t' || character === '\n' || character === '\r') index += 1;
      else break;
    }
  };
  const string = (): string => {
    if (text[index] !== '"') return fail();
    const start = index;
    index += 1;
    while (index < text.length) {
      const character = text[index];
      if (character === '"') {
        index += 1;
        try {
          const value: unknown = JSON.parse(text.slice(start, index));
          if (typeof value !== 'string') return fail();
          return value;
        } catch (error) {
          if (error instanceof RpcProtocolError) throw error;
          return fail();
        }
      }
      if (character === undefined) return fail();
      if (character.charCodeAt(0) < 0x20) return fail();
      if (character === '\\') {
        index += 1;
        const escape = text[index];
        if (escape === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(index + 1, index + 5))) return fail();
          index += 5;
          continue;
        }
        if (escape === undefined || !'"\\/bfnrt'.includes(escape)) return fail();
        index += 1;
        continue;
      }
      index += 1;
    }
    return fail();
  };
  const value = (depth: number): void => {
    whitespace();
    const character = text[index];
    if (character === '{') {
      if (depth >= JSON_MAX_DEPTH) return fail();
      index += 1;
      whitespace();
      const keys = new Set<string>();
      if (text[index] === '}') {
        index += 1;
        return;
      }
      while (true) {
        whitespace();
        const key = string();
        if (keys.has(key)) return fail();
        keys.add(key);
        whitespace();
        if (text[index] !== ':') return fail();
        index += 1;
        value(depth + 1);
        whitespace();
        if (text[index] === '}') {
          index += 1;
          return;
        }
        if (text[index] !== ',') return fail();
        index += 1;
      }
    }
    if (character === '[') {
      if (depth >= JSON_MAX_DEPTH) return fail();
      index += 1;
      whitespace();
      if (text[index] === ']') {
        index += 1;
        return;
      }
      while (true) {
        value(depth + 1);
        whitespace();
        if (text[index] === ']') {
          index += 1;
          return;
        }
        if (text[index] !== ',') return fail();
        index += 1;
      }
    }
    if (character === '"') {
      string();
      return;
    }
    if (text.startsWith('true', index)) {
      index += 4;
      return;
    }
    if (text.startsWith('false', index)) {
      index += 5;
      return;
    }
    if (text.startsWith('null', index)) {
      index += 4;
      return;
    }
    numberPattern.lastIndex = index;
    const match = numberPattern.exec(text);
    if (match === null) return fail();
    index = numberPattern.lastIndex;
  };
  value(0);
  whitespace();
  if (index !== text.length) fail();
}

/** Rejects numbers that overflowed to Infinity and lone surrogates after parsing. */
function assertJsonGraph(value: unknown): void {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) failData('json');
      continue;
    }
    if (typeof current === 'string') {
      if (hasLoneSurrogate(current)) failData('string');
      continue;
    }
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    if (current !== null && typeof current === 'object') {
      for (const key of Object.keys(current)) {
        if (hasLoneSurrogate(key)) failData('object');
        stack.push((current as Record<string, unknown>)[key]);
      }
    }
  }
}

/**
 * Serializes a pure-JSON value under a UTF-8 byte bound. Oversized values are
 * rejected by the running budget before a large clone is built. `maxBytes` may
 * be raised for independent, larger data channels; the default stays the control
 * envelope limit.
 */
export function encodeRpcJson(value: unknown, maxBytes: number = RPC_JSON_MAX_BYTES): string {
  assertByteLimit(maxBytes);
  const clone = snapshot(value, 0, new Set(), { left: maxBytes });
  const text = JSON.stringify(clone);
  if (typeof text !== 'string') failData('json');
  if (Buffer.byteLength(text, 'utf8') > maxBytes) failSize();
  return text;
}

/** Deterministic encoding for signed RPC metadata, retaining every legal JSON key. */
export function encodeCanonicalRpcJson(value: unknown, maxBytes: number = RPC_JSON_MAX_BYTES): string {
  assertByteLimit(maxBytes);
  const clone = snapshot(value, 0, new Set(), { left: maxBytes });
  const canonical = (item: RpcJson): string => {
    if (item === null || typeof item !== 'object') return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`;
    const record = item as Readonly<Record<string, RpcJson>>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  };
  const text = canonical(clone);
  if (Buffer.byteLength(text, 'utf8') > maxBytes) failSize();
  return text;
}

/** Parses strict, bounded pure JSON. Non-finite numbers and lone surrogates are rejected. */
export function decodeRpcJson(text: string, maxBytes: number = RPC_JSON_MAX_BYTES): RpcJson {
  assertByteLimit(maxBytes);
  if (typeof text !== 'string') failData('json');
  if (Buffer.byteLength(text, 'utf8') > maxBytes) failSize();
  scanJson(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RpcProtocolError('invalid_data', 'invalid JSON text');
  }
  assertJsonGraph(parsed);
  return parsed as RpcJson;
}

function jsonEquals(left: RpcJson, right: RpcJson): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!jsonEquals(left[index], right[index])) return false;
    }
    return true;
  }
  if (typeof left === 'object' && left !== null && right !== null && typeof right === 'object') {
    const leftRecord = left as Record<string, RpcJson>;
    const rightRecord = right as Record<string, RpcJson>;
    const keys = Object.keys(leftRecord);
    if (keys.length !== Object.keys(rightRecord).length) return false;
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(rightRecord, key)) return false;
      if (!jsonEquals(leftRecord[key], rightRecord[key])) return false;
    }
    return true;
  }
  return false;
}

function checkOptionalNonNegative(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!isNonNegativeSafeInteger(value)) failContract(`${field} must be a non-negative safe integer`);
  return value;
}

function checkOptionalFinite(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) failContract(`${field} must be a finite number`);
  return value;
}

function checkSchema(input: unknown, depth: number, seen: Set<object>): void {
  if (depth > SCHEMA_MAX_DEPTH) failContract('schema nesting exceeds the limit');
  if (!isPlainObject(input)) failContract('schema must be a plain object');
  if (seen.has(input)) failContract('schema must not contain cycles');
  seen.add(input);
  const type = input.type;
  if (type === 'string') {
    assertKnownKeys(input, ['type', 'minLength', 'maxLength'], 'schema');
    const min = checkOptionalNonNegative(input.minLength, 'minLength');
    const max = checkOptionalNonNegative(input.maxLength, 'maxLength');
    if (min !== undefined && max !== undefined && min > max) failContract('string minLength must not exceed maxLength');
  } else if (type === 'number') {
    assertKnownKeys(input, ['type', 'integer', 'minimum', 'maximum'], 'schema');
    if (input.integer !== undefined && typeof input.integer !== 'boolean') failContract('number integer flag must be boolean');
    const min = checkOptionalFinite(input.minimum, 'minimum');
    const max = checkOptionalFinite(input.maximum, 'maximum');
    if (min !== undefined && max !== undefined && min > max) failContract('number minimum must not exceed maximum');
  } else if (type === 'boolean') {
    assertKnownKeys(input, ['type'], 'schema');
  } else if (type === 'null') {
    assertKnownKeys(input, ['type'], 'schema');
  } else if (type === 'literal') {
    assertKnownKeys(input, ['type', 'value'], 'schema');
    if (!Object.prototype.hasOwnProperty.call(input, 'value')) failContract('literal schema requires a value');
    try {
      snapshot(input.value, 0, new Set(), { left: Infinity });
    } catch (error) {
      if (error instanceof RpcProtocolError && error.code === 'invalid_data') {
        failContract('literal value must be pure JSON');
      }
      throw error;
    }
  } else if (type === 'array') {
    assertKnownKeys(input, ['type', 'items', 'maxItems'], 'schema');
    if (!Object.prototype.hasOwnProperty.call(input, 'items')) failContract('array schema requires items');
    checkSchema(input.items, depth + 1, seen);
    checkOptionalNonNegative(input.maxItems, 'maxItems');
  } else if (type === 'object') {
    assertKnownKeys(input, ['type', 'properties', 'optional'], 'schema');
    const properties = input.properties;
    if (!isPlainObject(properties)) failContract('object schema requires a properties record');
    for (const key of Object.keys(properties)) checkSchema(properties[key], depth + 1, seen);
    const optional = input.optional;
    if (optional !== undefined) {
      if (!Array.isArray(optional)) failContract('object optional must be an array of field names');
      const names = new Set<string>();
      for (const name of optional) {
        if (typeof name !== 'string') failContract('object optional entries must be strings');
        if (names.has(name)) failContract('object optional entries must be unique');
        names.add(name);
        if (!Object.prototype.hasOwnProperty.call(properties, name)) {
          failContract('object optional names must exist in properties');
        }
      }
    }
  } else if (type === 'record') {
    assertKnownKeys(input, ['type', 'values', 'maxEntries'], 'schema');
    if (!Object.prototype.hasOwnProperty.call(input, 'values')) failContract('record schema requires values');
    checkSchema(input.values, depth + 1, seen);
    checkOptionalNonNegative(input.maxEntries, 'maxEntries');
  } else if (type === 'union') {
    assertKnownKeys(input, ['type', 'variants'], 'schema');
    const variants = input.variants;
    if (!Array.isArray(variants) || variants.length === 0) {
      failContract('union schema requires a non-empty variants array');
    }
    for (const variant of variants) checkSchema(variant, depth + 1, seen);
  } else if (type === 'json') {
    assertKnownKeys(input, ['type', 'maxBytes'], 'schema');
    if (input.maxBytes !== undefined && !isPositiveSafeInteger(input.maxBytes)) {
      failContract('json schema maxBytes must be a positive safe integer');
    }
  } else {
    failContract('unknown schema type');
  }
  seen.delete(input);
}

function validateValue(schema: RpcDataSchema, value: unknown): void {
  switch (schema.type) {
    case 'string': {
      if (typeof value !== 'string') failData('string');
      if (schema.minLength !== undefined && value.length < schema.minLength) failData('string');
      if (schema.maxLength !== undefined && value.length > schema.maxLength) failData('string');
      return;
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) failData('number');
      if (schema.integer === true && !Number.isInteger(value)) failData('number');
      if (schema.minimum !== undefined && value < schema.minimum) failData('number');
      if (schema.maximum !== undefined && value > schema.maximum) failData('number');
      return;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') failData('boolean');
      return;
    }
    case 'null': {
      if (value !== null) failData('null');
      return;
    }
    case 'literal': {
      if (!jsonEquals(schema.value, value as RpcJson)) failData('literal');
      return;
    }
    case 'array': {
      if (!Array.isArray(value)) failData('array');
      if (schema.maxItems !== undefined && value.length > schema.maxItems) failData('array');
      for (const item of value) validateValue(schema.items, item);
      return;
    }
    case 'object': {
      if (!isPlainObject(value)) failData('object');
      const optional = new Set(schema.optional ?? []);
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) failData('object');
      }
      for (const key of Object.keys(schema.properties)) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
          if (!optional.has(key)) failData('object');
          continue;
        }
        validateValue(schema.properties[key], value[key]);
      }
      return;
    }
    case 'record': {
      if (!isPlainObject(value)) failData('record');
      const keys = Object.keys(value);
      if (schema.maxEntries !== undefined && keys.length > schema.maxEntries) failData('record');
      for (const key of keys) validateValue(schema.values, value[key]);
      return;
    }
    case 'union': {
      for (const variant of schema.variants) {
        try {
          validateValue(variant, value);
          return;
        } catch (error) {
          if (!(error instanceof RpcProtocolError) || error.code !== 'invalid_data') throw error;
        }
      }
      failData('union');
    }
    case 'json': {
      const maxBytes = schema.maxBytes ?? RPC_JSON_MAX_BYTES;
      const text = JSON.stringify(value);
      if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > maxBytes) failData('json');
      return;
    }
  }
}

/**
 * Asserts a runtime value matches the schema. The whole value is first cloned
 * into bounded pure JSON without invoking accessors, then validated. Throws
 * `RpcProtocolError` with `invalid_data` (value) or `invalid_contract` (malformed
 * schema).
 */
/** Validates a standalone data schema (lane contract registration) without a value. */
export function assertRpcDataSchema(schema: RpcDataSchema): void {
  const pure = snapshotPureInput(schema);
  checkSchema(pure, 0, new Set());
}

export function assertRpcData<S extends RpcDataSchema>(
  schema: S,
  value: unknown,
  maxBytes?: number,
): asserts value is InferRpcData<S> {  const pureSchema = snapshotPureInput(schema);
  checkSchema(pureSchema, 0, new Set());
  const checkedSchema = pureSchema as unknown as RpcDataSchema;
  const limit = maxBytes ?? (checkedSchema.type === 'json' ? checkedSchema.maxBytes ?? RPC_JSON_MAX_BYTES : RPC_JSON_MAX_BYTES);
  assertByteLimit(limit);
  let pureValue: RpcJson;
  try { pureValue = snapshot(value, 0, new Set(), { left: limit }); }
  catch (error) {
    if (error instanceof RpcProtocolError && error.code === 'size_limit') failData('json');
    throw error;
  }
  if (Buffer.byteLength(JSON.stringify(pureValue), 'utf8') > limit) failData('json');
  validateValue(checkedSchema, pureValue);
}

function assertByteLimit(maxBytes: number): void {
  if (!isPositiveSafeInteger(maxBytes)) failContract('maxBytes must be a positive safe integer');
}

function checkByteLimit(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!isPositiveSafeInteger(value) || value > RPC_JSON_MAX_BYTES) {
    failContract(`${field} must be a positive integer no larger than the RPC envelope`);
  }
  return value;
}

function checkCommandPolicy(policy: Record<string, unknown>, maxOutputBytes: number): void {
  const keys = Object.keys(policy);
  if (keys.length !== RPC_COMMAND_POLICY_KEYS.size || keys.some((key) => !RPC_COMMAND_POLICY_KEYS.has(key))) {
    failContract('command policy fields are fixed');
  }
  const deduplication = policy.deduplication;
  if (typeof deduplication !== 'string' || !RPC_COMMAND_DEDUPLICATION.has(deduplication as RpcCommandDeduplication)) {
    failContract('invalid command deduplication');
  }
  const retention = policy.resultRetentionMs;
  if (retention !== null && !isPositiveSafeInteger(retention)) {
    failContract('resultRetentionMs must be a positive integer or null');
  }
  const maxResultBytes = policy.maxResultBytes;
  if (!isPositiveSafeInteger(maxResultBytes)) failContract('maxResultBytes must be a positive safe integer');
  if (maxResultBytes > maxOutputBytes) failContract('maxResultBytes must not exceed maxOutputBytes');
  const quotaBytes = policy.quotaBytes;
  if (!isPositiveSafeInteger(quotaBytes)) failContract('quotaBytes must be a positive safe integer');
  if (quotaBytes < maxResultBytes) failContract('quotaBytes must be able to hold maxResultBytes');
}

function checkMethod(definition: Record<string, unknown>): void {
  assertKnownKeys(definition, METHOD_KEYS, 'method');
  const kind = definition.kind;
  if (kind !== 'query' && kind !== 'command') failContract('method kind must be query or command');
  checkSchema(definition.input, 0, new Set());
  checkSchema(definition.output, 0, new Set());
  const purposes = definition.purposes;
  if (!Array.isArray(purposes) || purposes.length === 0) failContract('purposes must be a non-empty array');
  const seenPurposes = new Set<string>();
  for (const purpose of purposes) {
    if (typeof purpose !== 'string' || !RPC_CALL_PURPOSES.has(purpose as RpcCallPurpose)) failContract('invalid purpose');
    if (seenPurposes.has(purpose)) failContract('purposes must be unique');
    seenPurposes.add(purpose);
  }
  if (definition.timeoutMs !== undefined) {
    if (!isPositiveSafeInteger(definition.timeoutMs) || definition.timeoutMs > RPC_MAX_TIMEOUT_MS) {
      failContract('timeoutMs must be a positive integer no larger than the timeout bound');
    }
  }
  checkByteLimit(definition.maxInputBytes, 'maxInputBytes');
  const maxOutputBytes = checkByteLimit(definition.maxOutputBytes, 'maxOutputBytes');
  const command = definition.command;
  if (kind === 'command') {
    if (!isPlainObject(command)) failContract('command methods require an explicit command policy');
    checkCommandPolicy(command, maxOutputBytes ?? RPC_JSON_MAX_BYTES);
  } else if (command !== undefined) {
    failContract('query methods must not declare a command policy');
  }
}

function checkContract(contract: unknown): void {
  if (!isPlainObject(contract)) failContract('contract must be a plain object');
  assertKnownKeys(contract, CONTRACT_KEYS, 'contract');
  if (typeof contract.id !== 'string' || !RPC_SERVICE_ID.test(contract.id)) failContract('invalid service id');
  if (!isPositiveSafeInteger(contract.version)) failContract('service version must be a positive safe integer');
  const methods = contract.methods;
  if (!isPlainObject(methods)) failContract('methods must be a plain object');
  const names = Object.keys(methods);
  if (names.length === 0) failContract('service must declare at least one method');
  if (names.length > RPC_MAX_METHODS) failContract('service declares too many methods');
  for (const name of names) {
    if (!RPC_METHOD_NAME.test(name)) failContract('invalid method name');
    const definition = methods[name];
    if (!isPlainObject(definition)) failContract('method definition must be a plain object');
    checkMethod(definition);
  }
}

function deepFreeze(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    return Object.freeze(value);
  }
  return value;
}

/**
 * Validates a service contract and returns a deep-frozen pure clone. The caller's
 * objects are never read through accessors, never frozen, and never modified;
 * `methods` keeps its literal types so clients can derive call signatures.
 */
export function defineRpcService<const M extends Record<string, RpcMethodDefinition>>(contract: {
  readonly id: string;
  readonly version: number;
  readonly methods: M;
}): RpcServiceContract<M> {
  const pure = snapshotPureInput(contract);
  checkContract(pure);
  return deepFreeze(pure) as unknown as RpcServiceContract<M>;
}
