import { resolveRouteEndpoints, type Route, type Service } from '$api/routes';
import { validateUpstream } from './upstream-validator';
import { _ } from '$i18n';
import { get } from 'svelte/store';
import { DEFAULT_REQUEST_MS } from '$utils/route-timeouts';

export interface ValidationError {
  field: string;
  message: string;
}

export async function validateRoute(route: Partial<Route>, services: Service[] = []): Promise<ValidationError[]> {
  const errors: ValidationError[] = [];
  const endpoints = resolveRouteEndpoints(route, services);

  if (!route.path) {
    errors.push({ field: 'path', message: get(_)('validation.pathRequired') });
  } else if (!route.path.startsWith('/')) {
    errors.push({ field: 'path', message: get(_)('validation.pathStartSlash') });
  }

  if (route.service && !services.some((service) => service.name === route.service)) {
    errors.push({ field: 'service', message: `Service "${route.service}" not found` });
  }

  const hasGlobalResponseBypass = route.direct_response?.enabled || route.redirect?.enabled;

  route.response_rules?.forEach((rule, index) => {
    if (!rule.enabled) return;
    if (!rule.path?.trim()) {
      errors.push({ field: `response_rules.${index}.path`, message: get(_)('validation.pathRequired') });
    }
    if (rule.type === 'redirect' && !rule.url?.trim()) {
      errors.push({ field: `response_rules.${index}.url`, message: get(_)('validation.urlRequired') });
    }
  });

  if (!hasGlobalResponseBypass && !route.service && endpoints.length === 0) {
    errors.push({ field: 'endpoints', message: get(_)('validation.upstreamRequired') });
  } else if (!hasGlobalResponseBypass) {
    const upstreamValidations = endpoints.map((upstream, index) =>
      validateUpstream(upstream, index)
    );
    const upstreamErrors = await Promise.all(upstreamValidations);
    upstreamErrors.forEach(errorList => {
      errors.push(...errorList);
    });
  }

  if (route.path_rewrite) {
    Object.keys(route.path_rewrite).forEach(pattern => {
      try {
        new RegExp(pattern);
      } catch {
        const t = get(_);
        errors.push({
          field: `path_rewrite.${pattern}`,
          message: t('validation.invalidRegex', { values: { pattern } })
        });
      }
    });
  }

  const requestMs = route.timeouts?.request_ms;
  const firstResponseMs = route.timeouts?.first_response_ms;
  if (requestMs !== undefined && (!Number.isSafeInteger(requestMs) || requestMs < 100)) {
    errors.push({
      field: 'timeouts.request_ms',
      message: get(_)('validation.requestTimeoutPositive')
    });
  }
  if (firstResponseMs !== undefined) {
    if (!Number.isSafeInteger(firstResponseMs) || firstResponseMs < 100) {
      errors.push({ field: 'timeouts.first_response_ms', message: get(_)('validation.firstResponseTimeoutPositive') });
    } else if (firstResponseMs > (requestMs ?? DEFAULT_REQUEST_MS)) {
      errors.push({ field: 'timeouts.request_ms', message: get(_)('validation.requestTimeoutBelowFirstResponse') });
    }
  }

  return errors;
}

export function validateExpression(expr: string): { valid: boolean; error?: string } {
  const t = get(_);

  if (!expr.trim()) {
    return { valid: false, error: t('validation.expressionEmpty') };
  }

  const openBraces = (expr.match(/\{\{/g) || []).length;
  const closeBraces = (expr.match(/\}\}/g) || []).length;

  if (openBraces !== closeBraces) {
    return { valid: false, error: t('validation.mismatchedBraces') };
  }

  if (expr.includes('{{') && expr.includes('}}')) {
    const content = expr.match(/\{\{(.+?)\}\}/)?.[1];
    if (content) {
      const openParen = (content.match(/\(/g) || []).length;
      const closeParen = (content.match(/\)/g) || []).length;
      if (openParen !== closeParen) {
        return { valid: false, error: t('validation.mismatchedParentheses') };
      }

      const singleQuotes = (content.match(/'/g) || []).length;
      const doubleQuotes = (content.match(/"/g) || []).length;
      if (singleQuotes % 2 !== 0 || doubleQuotes % 2 !== 0) {
        return { valid: false, error: t('validation.mismatchedQuotes') };
      }
    }
  }

  return { valid: true };
}

export function hasExpression(value: any): boolean {
  if (typeof value === 'string') {
    return value.includes('{{') && value.includes('}}');
  }
  return false;
}

export function extractExpression(value: string): string | null {
  const match = value.match(/\{\{(.+?)\}\}/);
  return match ? match[1].trim() : null;
}
