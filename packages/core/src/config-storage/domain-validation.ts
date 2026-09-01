import { validateExpressionSyntax } from './expression-syntax';
import { validateModificationRules } from './modification-validation';
import { isObject } from './validation';
import { objectField } from './policy-fields';
import { validateRoutePolicies } from './route-policy-validation';
import { validateServicePolicies } from './service-policy-validation';
import type { JsonObject, ValidationContext } from './validation';

const AUTH_FIELDS = ['enabled', 'tokens'] as const;

export function validateAuth(value: unknown, path: string, context: ValidationContext): void {
  if (value === undefined) return;
  const object = objectField(value, path, AUTH_FIELDS, context);
  if (!object) return;
  if (typeof object.enabled !== 'boolean') context.add('invalid_auth', `${path}.enabled`, 'Expected a boolean');
  if (!('tokens' in object)) {
    context.add('required', `${path}.tokens`, 'Tokens are required');
  } else if (!Array.isArray(object.tokens)) {
    context.add('invalid_auth', `${path}.tokens`, 'Expected a token array');
  } else if (Array.isArray(object.tokens)) {
    object.tokens.forEach((token, index) => {
      if (typeof token !== 'string') {
        context.add('invalid_auth', `${path}.tokens[${index}]`, 'Token must be a string');
      } else if (object.enabled === true && !token.trim()) {
        context.add('invalid_auth', `${path}.tokens[${index}]`, 'Token must not be empty');
      }
    });
  }
  if (object.enabled === true) {
    if (!Array.isArray(object.tokens) || object.tokens.length === 0) {
      context.add('invalid_auth', `${path}.tokens`, 'Enabled auth requires at least one token');
    }
  }
}

export function validateUpstreamDomain(object: JsonObject, path: string, context: ValidationContext): void {
  if (typeof object.target === 'string') {
    try {
      const target = new URL(object.target);
      if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('protocol');
    } catch { context.add('invalid_url', `${path}.target`, 'Expected an absolute HTTP or HTTPS URL'); }
  }
  for (const field of ['weight', 'priority'] as const) {
    const value = object[field];
    if (typeof value === 'number' && Number.isFinite(value) && value <= 0) {
      context.add('invalid_positive_number', `${path}.${field}`, 'Expected a positive number');
    }
  }
  if (object.description !== undefined && typeof object.description !== 'string') {
    context.add('invalid_type', `${path}.description`, 'Expected a string');
  }
  validateModificationRules(object, path, context);
  validateExpressionSyntax(object.condition, `${path}.condition`, context);
}

export function validateServiceDomain(
  object: JsonObject,
  path: string,
  endpointCount: number,
  context: ValidationContext,
): void {
  if (endpointCount === 0) context.add('empty_service', `${path}.endpoints`, 'Service requires at least one upstream');
  validateServicePolicies(object, path, context);
}

export function validateRouteDomain(
  object: JsonObject,
  path: string,
  hasService: boolean,
  endpointCount: number,
  context: ValidationContext,
): void {
  if (typeof object.path === 'string' && !object.path.startsWith('/')) {
    context.add('invalid_path', `${path}.path`, 'Route path must start with /');
  }
  validateModificationRules(object, path, context);
  validateRoutePolicies(object, path, context);
  const direct = isObject(object.direct_response) && object.direct_response.enabled === true;
  const redirect = isObject(object.redirect) && object.redirect.enabled === true;
  const rules = Array.isArray(object.response_rules)
    && object.response_rules.some((rule) => typeof rule === 'object' && rule !== null
      && 'enabled' in rule && rule.enabled === true);
  if (!hasService && endpointCount === 0 && !direct && !redirect && !rules) {
    context.add('missing_route_target', path, 'Direct route requires upstreams or an enabled response policy');
  }
}
