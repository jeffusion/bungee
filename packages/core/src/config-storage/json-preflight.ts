import type { PluginConfigValue } from '@jeffusion/bungee-types';
import { isProxy } from 'node:util/types';
import type { ValidationContext } from './validation';
import { ValidationContext as JsonValidationContext } from './validation';
import { hasLoneSurrogate } from './utf16';

interface PendingValue {
  readonly value: unknown;
  readonly path: string;
  readonly assign: (value: PluginConfigValue) => void;
}

interface ReflectedProperty {
  readonly key: PropertyKey;
  readonly descriptor: PropertyDescriptor;
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function childPath(parent: string, key: string): string {
  return parent ? `${parent}.${key}` : key;
}

function symbolPath(parent: string, key: symbol): string {
  const segment = `[Symbol(${key.description ?? ''})]`;
  return `${parent}${segment}`;
}

function addInvalid(context: ValidationContext, path: string): void {
  context.add('non_json_value', path, 'Expected a JSON-compatible value');
}

function isCanonicalArrayIndex(key: string): boolean {
  if (!/^(?:0|[1-9]\d*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index <= 4_294_967_294 && String(index) === key;
}

function inspectObject(
  pending: PendingValue,
  stack: PendingValue[],
  seen: WeakSet<object>,
  context: ValidationContext,
): void {
  const source = pending.value as object;
  let array: boolean;
  let prototype: object | null;
  let properties: readonly ReflectedProperty[];
  let arrayLength = 0;
  try {
    if (isProxy(source)) throw new TypeError('Proxy objects are not JSON values');
    if (seen.has(source)) {
      addInvalid(context, pending.path);
      return;
    }
    seen.add(source);
    array = Array.isArray(source);
    prototype = Object.getPrototypeOf(source) as object | null;
    properties = Reflect.ownKeys(source).map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      if (!descriptor) throw new TypeError('Missing own property descriptor');
      return { key, descriptor };
    });
    if (array) {
      const descriptor = Object.getOwnPropertyDescriptor(source, 'length');
      if (!descriptor || typeof descriptor.value !== 'number') {
        throw new TypeError('Invalid array length descriptor');
      }
      arrayLength = descriptor.value;
    }
    if (Object.getPrototypeOf(source) !== prototype) {
      throw new TypeError('Prototype changed during reflection');
    }
  } catch {
    addInvalid(context, pending.path);
    return;
  }
  if ((!array && prototype !== Object.prototype && prototype !== null)
    || (array && prototype !== Array.prototype)) {
    addInvalid(context, pending.path);
    return;
  }
  const target: PluginConfigValue[] | Record<string, PluginConfigValue> = array ? [] : {};
  pending.assign(target);
  const children: PendingValue[] = [];
  const indexes: number[] = [];
  for (const { key, descriptor } of properties) {
    if (array && key === 'length') continue;
    if (typeof key === 'symbol') {
      addInvalid(context, symbolPath(pending.path, key));
      continue;
    }
    const propertyName = String(key);
    const arrayIndex = array && isCanonicalArrayIndex(propertyName);
    const path = arrayIndex
      ? `${pending.path}[${propertyName}]` : childPath(pending.path, propertyName);
    if (arrayIndex) indexes.push(Number(propertyName));
    if (array && !arrayIndex) {
      addInvalid(context, path);
      continue;
    }
    if (hasLoneSurrogate(propertyName)) addInvalid(context, path);
    if (!descriptor.enumerable || !('value' in descriptor)) {
      addInvalid(context, path);
      continue;
    }
    if (FORBIDDEN_KEYS.has(propertyName)) {
      context.add('forbidden_key', path, 'Key is forbidden in JSON configuration');
      children.push({ value: descriptor.value, path, assign() {} });
      continue;
    }
    children.push({
      value: descriptor.value,
      path,
      assign(value) {
        if (array) (target as PluginConfigValue[])[Number(propertyName)] = value;
        else Object.defineProperty(target, propertyName, {
          value, enumerable: true, writable: true, configurable: true,
        });
      },
    });
  }
  if (array && indexes.length !== arrayLength) {
    indexes.sort((left, right) => left - right);
    let expected = 0;
    for (const index of indexes) {
      if (index !== expected) break;
      expected += 1;
    }
    addInvalid(context, `${pending.path}[${expected}]`);
  }
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index];
    if (child !== undefined) stack.push(child);
  }
}

export class JsonSnapshotError extends Error {
  readonly name = 'JsonSnapshotError';

  constructor(readonly errors: readonly { readonly path: string; readonly message: string }[]) {
    super('Value is not a side-effect-free JSON graph');
  }
}

export function snapshotJsonGraph(input: unknown): PluginConfigValue {
  const context = new JsonValidationContext();
  const value = preflightJsonGraph(input, context);
  if (value === undefined || context.errors.length > 0) {
    throw new JsonSnapshotError(context.errors);
  }
  return value;
}

export function preflightJsonGraph(
  input: unknown,
  context: ValidationContext,
): PluginConfigValue | undefined {
  let output: PluginConfigValue | undefined;
  const stack: PendingValue[] = [{ value: input, path: '', assign(value) { output = value; } }];
  const seen = new WeakSet<object>();
  while (stack.length) {
    const pending = stack.pop();
    if (pending === undefined) break;
    const value = pending.value;
    if (value === null || typeof value === 'boolean') pending.assign(value);
    else if (typeof value === 'string') {
      if (hasLoneSurrogate(value)) addInvalid(context, pending.path);
      else pending.assign(value);
    }
    else if (typeof value === 'number') {
      if (Number.isFinite(value)) pending.assign(value);
      else addInvalid(context, pending.path);
    } else if (typeof value === 'object') inspectObject(pending, stack, seen, context);
    else addInvalid(context, pending.path);
  }
  return context.errors.length ? undefined : output;
}
