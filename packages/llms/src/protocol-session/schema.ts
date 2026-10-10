import { fail, list, record, string, type JsonRecord } from '../responses-codec/common';
import { fields, bool } from './validation';

/** Gemini's Schema is an OpenAPI dialect, not JSON Schema. Preserve supported
 * constraints exactly and reject provider-specific ordering or unknown extensions.
 */
export function geminiSchemaToJson(raw: unknown, path: string, code = 'unsupported_request', depth = 0): JsonRecord {
  if (depth > 64) fail('resource_limit', 'Schema nesting exceeds the conversion limit', path);
  const s = record(raw, path);
  fields(s, ['type', 'format', 'title', 'description', 'nullable', 'enum', 'items', 'properties', 'required', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'minProperties', 'maxProperties', 'anyOf', 'default', 'example'], path, code);
  const out: JsonRecord = {};
  if (s.type !== undefined) { const types: Record<string, string> = { STRING: 'string', NUMBER: 'number', INTEGER: 'integer', BOOLEAN: 'boolean', ARRAY: 'array', OBJECT: 'object', NULL: 'null' }; const type = types[string(s.type, `${path}.type`)]; if (!type) fail(code, 'Unknown Gemini schema type', `${path}.type`); out.type = type; }
  for (const key of ['format', 'title', 'description', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'minProperties', 'maxProperties', 'default']) if (s[key] !== undefined) out[key] = s[key];
  if (s.example !== undefined) out.examples = [s.example];
  if (s.required !== undefined) out.required = list(s.required, `${path}.required`).map(v => string(v, `${path}.required`, true));
  if (s.enum !== undefined) out.enum = list(s.enum, `${path}.enum`).map(v => string(v, `${path}.enum`));
  if (s.items !== undefined) out.items = geminiSchemaToJson(s.items, `${path}.items`, code, depth + 1);
  if (s.properties !== undefined) { const properties = record(s.properties, `${path}.properties`); out.properties = Object.fromEntries(Object.entries(properties).map(([name, schema]) => [name, geminiSchemaToJson(schema, `${path}.properties.${name}`, code, depth + 1)])); }
  if (s.anyOf !== undefined) out.anyOf = list(s.anyOf, `${path}.anyOf`).map((v, i) => geminiSchemaToJson(v, `${path}.anyOf[${i}]`, code, depth + 1));
  if (s.nullable !== undefined && bool(s.nullable, `${path}.nullable`)) return { anyOf: [out, { type: 'null' }] };
  return out;
}
