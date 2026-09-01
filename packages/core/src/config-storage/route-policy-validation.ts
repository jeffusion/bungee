import { validateAuth } from './domain-validation';
import { validateExpressionSyntax } from './expression-syntax';
import {
  booleanField, numberField, objectField, optionalBoolean, optionalString,
  requiredString, status, stringArray, stringRecord,
} from './policy-fields';
import { isObject, type JsonObject, type ValidationContext } from './validation';

function validatePathRewrite(value: unknown, path: string, context: ValidationContext): void {
  if (value === undefined) return;
  if (!isObject(value)) {
    context.add('invalid_type', path, 'Expected an object');
    return;
  }
  for (const [pattern, replacement] of Object.entries(value)) {
    if (typeof replacement !== 'string') context.add('invalid_type', `${path}.${pattern}`, 'Expected a string');
    try { new RegExp(pattern); } catch { context.add('invalid_value', `${path}.${pattern}`, 'Invalid regular expression'); }
  }
}

function validateRateLimit(value: unknown, path: string, context: ValidationContext): void {
  const object = objectField(value, path, ['enabled', 'requests_per_second', 'burst', 'key_expression'], context);
  if (!object) return;
  booleanField(object, 'enabled', path, context);
  numberField(object, 'requests_per_second', path, context, { positive: true });
  numberField(object, 'burst', path, context, { positive: true });
  validateExpressionSyntax(object.key_expression, `${path}.key_expression`, context);
}

function validateCors(value: unknown, path: string, context: ValidationContext): void {
  const object = objectField(value, path, ['enabled', 'allowed_origins', 'allowed_methods', 'allowed_headers',
    'expose_headers', 'allow_credentials', 'max_age'], context);
  if (!object) return;
  booleanField(object, 'enabled', path, context);
  for (const field of ['allowed_origins', 'allowed_methods', 'allowed_headers', 'expose_headers']) {
    if (object[field] !== undefined) stringArray(object[field], `${path}.${field}`, context);
  }
  optionalBoolean(object, 'allow_credentials', path, context);
  numberField(object, 'max_age', path, context, { nonNegative: true });
}

function validateResponseRule(value: unknown, path: string, context: ValidationContext): void {
  const fields = ['enabled', 'path', 'match_type', 'type', 'status', 'body', 'content_type',
    'headers', 'url', 'preserve_path'];
  const object = objectField(value, path, fields, context);
  if (!object) return;
  booleanField(object, 'enabled', path, context);
  requiredString(object, 'path', path, context);
  if (object.match_type !== undefined && !['exact', 'prefix', 'regex'].includes(String(object.match_type))) {
    context.add('invalid_value', `${path}.match_type`, 'Unsupported match type');
  }
  if (object.match_type === 'regex' && typeof object.path === 'string') {
    try { new RegExp(object.path); } catch { context.add('invalid_value', `${path}.path`, 'Invalid regular expression'); }
  }
  if (object.type !== 'direct_response' && object.type !== 'redirect') {
    context.add('invalid_value', `${path}.type`, 'Unsupported response rule type');
  }
  optionalString(object, 'body', path, context);
  optionalString(object, 'content_type', path, context);
  if (object.headers !== undefined) stringRecord(object.headers, `${path}.headers`, context);
  optionalBoolean(object, 'preserve_path', path, context);
  if (object.type === 'direct_response') {
    if (object.status !== undefined) status(object.status, `${path}.status`, context);
    if (object.url !== undefined) context.add('invalid_value', `${path}.url`, 'URL is only valid for redirects');
  } else if (object.type === 'redirect') {
    requiredString(object, 'url', path, context);
    if (object.status !== undefined && (typeof object.status !== 'number'
      || ![301, 302, 307, 308].includes(object.status))) {
      context.add('invalid_value', `${path}.status`, 'Unsupported redirect status');
    }
  }
}

function validateResponseRules(value: unknown, path: string, context: ValidationContext): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    context.add('invalid_type', path, 'Expected an array');
    return;
  }
  value.forEach((item, index) => {
    validateResponseRule(item, `${path}[${index}]`, context);
  });
}

function validateDirect(value: unknown, path: string, context: ValidationContext): void {
  const object = objectField(value, path, ['enabled', 'status', 'body', 'content_type', 'headers'], context);
  if (!object) return;
  booleanField(object, 'enabled', path, context);
  status(object.status, `${path}.status`, context);
  optionalString(object, 'body', path, context);
  optionalString(object, 'content_type', path, context);
  if (object.headers !== undefined) stringRecord(object.headers, `${path}.headers`, context);
}

function validateRedirect(value: unknown, path: string, context: ValidationContext): void {
  const object = objectField(value, path, ['enabled', 'url', 'status', 'preserve_path'], context);
  if (!object) return;
  booleanField(object, 'enabled', path, context);
  requiredString(object, 'url', path, context);
  if (object.status !== undefined && (typeof object.status !== 'number'
    || ![301, 302, 307, 308].includes(object.status))) {
    context.add('invalid_value', `${path}.status`, 'Unsupported redirect status');
  }
  optionalBoolean(object, 'preserve_path', path, context);
}

function validateRetry(value: unknown, path: string, context: ValidationContext): void {
  const object = objectField(value, path, ['enabled', 'max_retries', 'retry_on', 'per_retry_timeout_ms'], context);
  if (!object) return;
  booleanField(object, 'enabled', path, context);
  numberField(object, 'max_retries', path, context, { nonNegative: true, integer: true });
  if (object.retry_on !== undefined) {
    if (!Array.isArray(object.retry_on)) context.add('invalid_type', `${path}.retry_on`, 'Expected an array');
    else object.retry_on.forEach((item, index) => {
      status(item, `${path}.retry_on[${index}]`, context);
    });
  }
  numberField(object, 'per_retry_timeout_ms', path, context, { positive: true });
}

export function validateRoutePolicies(object: JsonObject, path: string, context: ValidationContext): void {
  validatePathRewrite(object.path_rewrite, `${path}.path_rewrite`, context);
  validateAuth(object.auth, `${path}.auth`, context);
  const timeouts = objectField(object.timeouts, `${path}.timeouts`, ['request_ms'], context);
  if (timeouts) numberField(timeouts, 'request_ms', `${path}.timeouts`, context, { positive: true });
  validateRateLimit(object.rate_limit, `${path}.rate_limit`, context);
  validateCors(object.cors, `${path}.cors`, context);
  validateResponseRules(object.response_rules, `${path}.response_rules`, context);
  validateDirect(object.direct_response, `${path}.direct_response`, context);
  validateRedirect(object.redirect, `${path}.redirect`, context);
  validateRetry(object.retry, `${path}.retry`, context);
}
