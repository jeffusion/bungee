import { analyzeExpressionDependencies } from '../utils/expression-dependencies';
import { isObject, rejectUnknownFields, type JsonObject, type ValidationContext } from './validation';
import { stringArray, stringRecord } from './policy-fields';

const HEADER_FIELDS = new Set(['add', 'replace', 'default', 'remove']);
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
    if (headers.default !== undefined) stringRecord(headers.default, `${prefix}headers.default`, context);
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

/** 方向块独立校验；请求阶段和 SSE 响应头不允许读取尚不可用的数据。 */
export function validateDirectionalModificationRules(object: JsonObject, path: string, context: ValidationContext): void {
  for (const direction of ['request', 'response'] as const) {
    const blockPath = `${path}.${direction}`;
    const block = modificationObject(object[direction], blockPath,
      new Set(direction === 'request' ? ['headers', 'body', 'query'] : ['headers', 'body', 'body_formats']), context);
    if (!block) continue;
    validateModificationRules(block, blockPath, context);
    if (direction === 'response' && block.body_formats !== undefined) {
      if (!Array.isArray(block.body_formats) || block.body_formats.some(format => format !== 'json' && format !== 'sse-json')
        || new Set(block.body_formats).size !== block.body_formats.length) {
        context.add('invalid_value', `${blockPath}.body_formats`, 'Expected unique json or sse-json formats');
      }
    }
    try {
      analyzeExpressionDependencies(block, direction);
      if (direction === 'response' && (!Array.isArray(block.body_formats) || block.body_formats.includes('sse-json'))
        && analyzeExpressionDependencies(block.headers, direction).responseBody) {
        context.add('invalid_expression', `${blockPath}.headers`, 'SSE response headers cannot depend on the current response body; use request.body or restrict body_formats to json');
      }
    } catch (error) {
      context.add('invalid_expression', blockPath, error instanceof Error ? error.message : String(error));
    }
  }
}
