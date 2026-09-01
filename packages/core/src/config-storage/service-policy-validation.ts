import { validateExpressionSyntax } from './expression-syntax';
import {
  booleanField,
  numberField,
  objectField,
  optionalBoolean,
  optionalString,
  stringArray,
  stringRecord,
} from './policy-fields';
import type { JsonObject, ValidationContext } from './validation';

const HEALTH_FIELDS = ['enabled', 'interval_ms', 'timeout_ms', 'path', 'method', 'expected_status',
  'unhealthy_threshold', 'healthy_threshold', 'body', 'content_type', 'headers', 'query',
  'auto_enable_on_active_health_check'] as const;
const FAILOVER_FIELDS = ['enabled', 'retry_on', 'retry_on_response', 'passive_health', 'recovery', 'slow_start'] as const;

function validateTimeouts(value: unknown, path: string, context: ValidationContext): void {
  const object = objectField(value, path, ['connect_ms', 'send_ms', 'read_ms'], context);
  if (!object) return;
  for (const field of ['connect_ms', 'send_ms', 'read_ms']) {
    numberField(object, field, path, context, { positive: true });
  }
}

function validateHealth(value: unknown, path: string, context: ValidationContext): void {
  const object = objectField(value, path, HEALTH_FIELDS, context);
  if (!object) return;
  booleanField(object, 'enabled', path, context);
  for (const field of ['interval_ms', 'timeout_ms', 'unhealthy_threshold', 'healthy_threshold']) {
    numberField(object, field, path, context, { positive: true });
  }
  for (const field of ['path', 'method', 'body', 'content_type']) optionalString(object, field, path, context);
  if (object.expected_status !== undefined) {
    if (!Array.isArray(object.expected_status)) context.add('invalid_type', `${path}.expected_status`, 'Expected an array');
    else object.expected_status.forEach((item, index) => {
      validateStatus(item, `${path}.expected_status[${index}]`, context);
    });
  }
  if (object.headers !== undefined) stringRecord(object.headers, `${path}.headers`, context);
  if (object.query !== undefined) stringRecord(object.query, `${path}.query`, context);
  optionalBoolean(object, 'auto_enable_on_active_health_check', path, context);
}

function validateStatus(value: unknown, path: string, context: ValidationContext): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 100 || value > 599) {
    context.add('invalid_value', path, 'Expected an HTTP status');
  }
}

function validateRetryOn(value: unknown, path: string, context: ValidationContext): void {
  const valid = (item: unknown) => typeof item === 'string' || (typeof item === 'number' && Number.isFinite(item));
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      if (!valid(item)) context.add('invalid_type', `${path}[${index}]`, 'Expected a string or number');
    });
  } else if (!valid(value)) context.add('invalid_type', path, 'Expected a string, number, or array');
}

function validatePositiveObject(
  value: unknown,
  path: string,
  fields: readonly string[],
  context: ValidationContext,
): JsonObject | undefined {
  const object = objectField(value, path, fields, context);
  if (object) fields.forEach((field) => {
    numberField(object, field, path, context, { positive: true });
  });
  return object;
}

function validateFailover(value: unknown, path: string, context: ValidationContext): void {
  const object = objectField(value, path, FAILOVER_FIELDS, context);
  if (!object) return;
  booleanField(object, 'enabled', path, context);
  if (object.retry_on !== undefined) validateRetryOn(object.retry_on, `${path}.retry_on`, context);
  if (object.retry_on_response !== undefined) stringArray(object.retry_on_response, `${path}.retry_on_response`, context);
  validatePositiveObject(object.passive_health, `${path}.passive_health`,
    ['consecutive_failures', 'healthy_successes', 'auto_disable_threshold'], context);
  validatePositiveObject(object.recovery, `${path}.recovery`, ['backoff_base_ms', 'probe_timeout_ms'], context);
  const slow = objectField(object.slow_start, `${path}.slow_start`,
    ['enabled', 'duration_ms', 'initial_weight_factor'], context);
  if (!slow) return;
  booleanField(slow, 'enabled', `${path}.slow_start`, context);
  numberField(slow, 'duration_ms', `${path}.slow_start`, context, { positive: true });
  const factor = slow.initial_weight_factor;
  if (factor !== undefined && (typeof factor !== 'number' || !Number.isFinite(factor) || factor <= 0 || factor > 1)) {
    context.add('invalid_value', `${path}.slow_start.initial_weight_factor`, 'Expected a finite number in (0, 1]');
  }
}

function validateLoadBalancing(value: unknown, path: string, context: ValidationContext): void {
  const object = objectField(value, path, ['policy', 'hash_policy'], context);
  if (!object) return;
  const policies = new Set(['weighted_random', 'round_robin', 'least_requests', 'consistent_hash']);
  if (typeof object.policy !== 'string' || !policies.has(object.policy)) {
    context.add('invalid_load_balancing', `${path}.policy`, 'Unsupported load balancing policy');
  }
  const hash = objectField(object.hash_policy, `${path}.hash_policy`, ['header', 'expression'], context);
  if (hash) {
    optionalString(hash, 'header', `${path}.hash_policy`, context);
    validateExpressionSyntax(hash.expression, `${path}.hash_policy.expression`, context);
  }
  if (object.policy === 'consistent_hash') {
    const header = typeof hash?.header === 'string' ? hash.header.trim() : '';
    const expression = typeof hash?.expression === 'string' ? hash.expression.trim() : '';
    const headerShapeValid = hash?.header === undefined || typeof hash.header === 'string';
    const expressionShapeValid = hash?.expression === undefined || typeof hash.expression === 'string';
    if (!header && !expression && headerShapeValid && expressionShapeValid) {
      context.add('invalid_load_balancing', `${path}.hash_policy`, 'Hash input is required');
    }
  }
}

export function validateServicePolicies(object: JsonObject, path: string, context: ValidationContext): void {
  validateTimeouts(object.timeouts, `${path}.timeouts`, context);
  validateHealth(object.health_check, `${path}.health_check`, context);
  validateFailover(object.failover, `${path}.failover`, context);
  validateLoadBalancing(object.load_balancing, `${path}.load_balancing`, context);
}
