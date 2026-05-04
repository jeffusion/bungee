import type { Route } from '../api/routes';
import { validateUpstream } from './upstream-validator';
import { _ } from '../i18n';
import { get } from 'svelte/store';

export interface ValidationError {
  field: string;
  message: string;
}

function normalizeRetryableStatusCodeRules(
  rules: number | string | (number | string)[]
): Array<number | string> {
  const inputArray = Array.isArray(rules) ? rules : [rules];
  const normalized: Array<number | string> = [];

  inputArray.forEach((rule) => {
    if (typeof rule === 'number') {
      normalized.push(rule);
      return;
    }

    if (typeof rule !== 'string') {
      return;
    }

    rule.split(',').forEach((part) => {
      const trimmed = part.trim();
      if (!trimmed) {
        return;
      }

      const numeric = Number(trimmed);
      if (Number.isInteger(numeric) && numeric.toString() === trimmed) {
        normalized.push(numeric);
      } else {
        normalized.push(trimmed);
      }
    });
  });

  return normalized;
}

function isValidNumericStatusCode(code: number): boolean {
  return Number.isInteger(code) && code >= 100 && code <= 599;
}

function isValidRetryableStatusCodeRule(rule: number | string): boolean {
  if (typeof rule === 'number') {
    return isValidNumericStatusCode(rule);
  }

  const trimmedRule = rule.trim();
  if (!trimmedRule) {
    return false;
  }

  const exactMatch = trimmedRule.match(/^(\d{3})$/);
  if (exactMatch) {
    return isValidNumericStatusCode(Number(exactMatch[1]));
  }

  const comparatorMatch = trimmedRule.match(/^(>=|>|<=|<|!)\s*(\d{3})$/);
  if (comparatorMatch) {
    return isValidNumericStatusCode(Number(comparatorMatch[2]));
  }

  return /^([0-9])xx$/i.test(trimmedRule);
}

export async function validateRoute(route: Partial<Route>): Promise<ValidationError[]> {
  const errors: ValidationError[] = [];

  if (!route.path) {
    errors.push({ field: 'path', message: get(_)('validation.pathRequired') });
  } else if (!route.path.startsWith('/')) {
    errors.push({ field: 'path', message: get(_)('validation.pathStartSlash') });
  }

  if (!route.upstreams || route.upstreams.length === 0) {
    errors.push({ field: 'upstreams', message: get(_)('validation.upstreamRequired') });
  } else {
    const upstreamValidations = route.upstreams.map((upstream, index) =>
      validateUpstream(upstream, index)
    );
    const upstreamErrors = await Promise.all(upstreamValidations);
    upstreamErrors.forEach(errorList => {
      errors.push(...errorList);
    });
  }

  if (route.pathRewrite) {
    Object.keys(route.pathRewrite).forEach(pattern => {
      try {
        new RegExp(pattern);
      } catch {
        const t = get(_);
        errors.push({
          field: `pathRewrite.${pattern}`,
          message: t('validation.invalidRegex', { values: { pattern } })
        });
      }
    });
  }

  if (route.failover?.enabled) {
    if (route.failover.retryOn) {
      const retryableStatusCodes = normalizeRetryableStatusCodeRules(route.failover.retryOn);

      retryableStatusCodes.forEach((code) => {
        if (!isValidRetryableStatusCodeRule(code)) {
          const t = get(_);
          errors.push({
            field: 'failover.retryOn',
            message: t('validation.invalidStatusCode', { values: { code } })
          });
        }
      });
    }

    if (route.failover.recovery?.probeIntervalMs !== undefined && route.failover.recovery.probeIntervalMs <= 0) {
      errors.push({
        field: 'failover.recovery.probeIntervalMs',
        message: get(_)('validation.recoveryIntervalPositive')
      });
    }

    if (route.failover.recovery?.probeTimeoutMs !== undefined && route.failover.recovery.probeTimeoutMs <= 0) {
      errors.push({
        field: 'failover.recovery.probeTimeoutMs',
        message: get(_)('validation.recoveryTimeoutPositive')
      });
    }
  }

  if (route.timeouts?.requestMs !== undefined && route.timeouts.requestMs <= 0) {
    errors.push({
      field: 'timeouts.requestMs',
      message: get(_)('validation.requestTimeoutPositive')
    });
  }

  if (route.timeouts?.connectMs !== undefined && route.timeouts.connectMs <= 0) {
    errors.push({
      field: 'timeouts.connectMs',
      message: get(_)('validation.connectTimeoutPositive')
    });
  }

  if (route.stickySession?.enabled && route.stickySession.keyExpression !== undefined) {
    const stickyExpression = route.stickySession.keyExpression;
    if (!stickyExpression.trim()) {
      errors.push({
        field: 'stickySession.keyExpression',
        message: get(_)('validation.expressionEmpty')
      });
    } else {
      const expressionValidation = validateExpression(stickyExpression);
      if (!expressionValidation.valid) {
        errors.push({
          field: 'stickySession.keyExpression',
          message: expressionValidation.error || get(_)('validation.expressionEmpty')
        });
      }
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
