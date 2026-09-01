import { isObject, rejectUnknownFields, type JsonObject, type ValidationContext } from './validation';

export function objectField(
  value: unknown,
  path: string,
  fields: readonly string[],
  context: ValidationContext,
): JsonObject | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    context.add('invalid_type', path, 'Expected an object');
    return undefined;
  }
  rejectUnknownFields(value, new Set(fields), path, context);
  return value;
}

export function booleanField(object: JsonObject, key: string, path: string, context: ValidationContext): void {
  if (!(key in object) || typeof object[key] !== 'boolean') {
    context.add('invalid_type', `${path}.${key}`, 'Expected a boolean');
  }
}

export function optionalBoolean(object: JsonObject, key: string, path: string, context: ValidationContext): void {
  if (object[key] !== undefined && typeof object[key] !== 'boolean') {
    context.add('invalid_type', `${path}.${key}`, 'Expected a boolean');
  }
}

export function optionalString(object: JsonObject, key: string, path: string, context: ValidationContext): void {
  if (object[key] !== undefined && typeof object[key] !== 'string') {
    context.add('invalid_type', `${path}.${key}`, 'Expected a string');
  }
}

export function requiredString(object: JsonObject, key: string, path: string, context: ValidationContext): void {
  if (typeof object[key] !== 'string' || !object[key].trim()) {
    context.add('invalid_type', `${path}.${key}`, 'Expected a non-empty string');
  }
}

export function numberField(
  object: JsonObject,
  key: string,
  path: string,
  context: ValidationContext,
  options: { readonly required?: boolean; readonly positive?: boolean; readonly nonNegative?: boolean; readonly integer?: boolean } = {},
): void {
  const value = object[key];
  if (value === undefined && !options.required) return;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    context.add('invalid_type', `${path}.${key}`, 'Expected a finite number');
    return;
  }
  if (options.positive && value <= 0) {
    context.add('invalid_positive_number', `${path}.${key}`, 'Expected a positive number');
  } else if ((options.nonNegative && value < 0) || (options.integer && !Number.isSafeInteger(value))) {
    context.add('invalid_value', `${path}.${key}`, 'Number is outside the allowed range');
  }
}

export function stringArray(value: unknown, path: string, context: ValidationContext): void {
  if (!Array.isArray(value)) {
    context.add('invalid_type', path, 'Expected an array');
    return;
  }
  value.forEach((item, index) => {
    if (typeof item !== 'string') context.add('invalid_type', `${path}[${index}]`, 'Expected a string');
  });
}

export function stringRecord(value: unknown, path: string, context: ValidationContext): void {
  if (!isObject(value)) {
    context.add('invalid_type', path, 'Expected an object');
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') context.add('invalid_type', `${path}.${key}`, 'Expected a string');
  }
}

export function status(value: unknown, path: string, context: ValidationContext): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 100 || value > 599) {
    context.add('invalid_value', path, 'Expected an HTTP status from 100 to 599');
  }
}
