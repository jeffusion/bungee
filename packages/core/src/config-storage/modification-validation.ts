import { isObject, rejectUnknownFields, type JsonObject, type ValidationContext } from './validation';
import { stringArray, stringRecord } from './policy-fields';

const HEADER_FIELDS = new Set(['add', 'replace', 'remove']);
const BODY_FIELDS = new Set(['add', 'replace', 'remove', 'default']);
const QUERY_FIELDS = new Set(['add', 'replace', 'remove', 'default']);

function modificationObject(
  value: unknown,
  path: string,
  allowed: ReadonlySet<string>,
  context: ValidationContext,
): JsonObject | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    context.add('invalid_type', path, 'Expected an object');
    return undefined;
  }
  rejectUnknownFields(value, allowed, path, context);
  return value;
}

function jsonRecord(value: unknown, path: string, context: ValidationContext): void {
  if (!isObject(value)) context.add('invalid_type', path, 'Expected an object');
}

export function validateModificationRules(
  object: JsonObject,
  path: string,
  context: ValidationContext,
): void {
  const prefix = path ? `${path}.` : '';
  const headers = modificationObject(object.headers, `${prefix}headers`, HEADER_FIELDS, context);
  if (headers) {
    if (headers.add !== undefined) stringRecord(headers.add, `${prefix}headers.add`, context);
    if (headers.replace !== undefined) stringRecord(headers.replace, `${prefix}headers.replace`, context);
    if (headers.remove !== undefined) stringArray(headers.remove, `${prefix}headers.remove`, context);
  }
  const body = modificationObject(object.body, `${prefix}body`, BODY_FIELDS, context);
  if (body) {
    if (body.add !== undefined) jsonRecord(body.add, `${prefix}body.add`, context);
    if (body.replace !== undefined) jsonRecord(body.replace, `${prefix}body.replace`, context);
    if (body.remove !== undefined) stringArray(body.remove, `${prefix}body.remove`, context);
    if (body.default !== undefined) jsonRecord(body.default, `${prefix}body.default`, context);
  }
  const query = modificationObject(object.query, `${prefix}query`, QUERY_FIELDS, context);
  if (query) {
    if (query.add !== undefined) stringRecord(query.add, `${prefix}query.add`, context);
    if (query.replace !== undefined) stringRecord(query.replace, `${prefix}query.replace`, context);
    if (query.remove !== undefined) stringArray(query.remove, `${prefix}query.remove`, context);
    if (query.default !== undefined) stringRecord(query.default, `${prefix}query.default`, context);
  }
}
