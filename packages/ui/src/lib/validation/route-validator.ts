import type { Route } from '../api/routes';
import { validateUpstream } from './upstream-validator';

export interface ValidationError {
  field: string;
  message: string;
}

/**
 * 验证路由配置
 */
export async function validateRoute(route: Partial<Route>): Promise<ValidationError[]> {
  const errors: ValidationError[] = [];

  // 验证 path
  if (!route.path) {
    errors.push({ field: 'path', message: 'Path is required' });
  } else if (!route.path.startsWith('/')) {
    errors.push({ field: 'path', message: 'Path must start with /' });
  }

  // 验证 upstreams (异步验证)
  if (!route.upstreams || route.upstreams.length === 0) {
    errors.push({ field: 'upstreams', message: 'At least one upstream is required' });
  } else {
    // 并行验证所有upstreams
    const upstreamValidations = route.upstreams.map((upstream, index) =>
      validateUpstream(upstream, index)
    );
    const upstreamErrors = await Promise.all(upstreamValidations);
    upstreamErrors.forEach(errorList => errors.push(...errorList));
  }

  // 验证 pathRewrite
  if (route.pathRewrite) {
    Object.keys(route.pathRewrite).forEach(pattern => {
      try {
        new RegExp(pattern);
      } catch {
        errors.push({
          field: `pathRewrite.${pattern}`,
          message: `Invalid regex pattern: ${pattern}`
        });
      }
    });
  }

  // 验证 failover
  if (route.failover?.enabled) {
    if (route.failover.retryableStatusCodes) {
      route.failover.retryableStatusCodes.forEach(code => {
        if (code < 100 || code > 599) {
          errors.push({
            field: 'failover.retryableStatusCodes',
            message: `Invalid status code: ${code}`
          });
        }
      });
    }
  }

  // 验证 healthCheck
  if (route.healthCheck?.enabled) {
    if (route.healthCheck.interval !== undefined && route.healthCheck.interval <= 0) {
      errors.push({
        field: 'healthCheck.interval',
        message: 'Interval must be greater than 0'
      });
    }
    if (route.healthCheck.timeout !== undefined && route.healthCheck.timeout <= 0) {
      errors.push({
        field: 'healthCheck.timeout',
        message: 'Timeout must be greater than 0'
      });
    }
    if (route.healthCheck.path && !route.healthCheck.path.startsWith('/')) {
      errors.push({
        field: 'healthCheck.path',
        message: 'Health check path must start with /'
      });
    }
  }

  return errors;
}

/**
 * 验证动态表达式
 */
export function validateExpression(expr: string): { valid: boolean; error?: string } {
  // 简单的表达式语法检查
  if (!expr.trim()) {
    return { valid: false, error: 'Expression cannot be empty' };
  }

  // 检查括号匹配
  const openBraces = (expr.match(/\{\{/g) || []).length;
  const closeBraces = (expr.match(/\}\}/g) || []).length;

  if (openBraces !== closeBraces) {
    return { valid: false, error: 'Mismatched {{ }} braces' };
  }

  // 检查常见的语法错误
  if (expr.includes('{{') && expr.includes('}}')) {
    const content = expr.match(/\{\{(.+?)\}\}/)?.[1];
    if (content) {
      // 检查是否有未闭合的括号
      const openParen = (content.match(/\(/g) || []).length;
      const closeParen = (content.match(/\)/g) || []).length;
      if (openParen !== closeParen) {
        return { valid: false, error: 'Mismatched parentheses' };
      }

      // 检查是否有未闭合的引号
      const singleQuotes = (content.match(/'/g) || []).length;
      const doubleQuotes = (content.match(/"/g) || []).length;
      if (singleQuotes % 2 !== 0 || doubleQuotes % 2 !== 0) {
        return { valid: false, error: 'Mismatched quotes' };
      }
    }
  }

  return { valid: true };
}

/**
 * 检查字段值是否包含动态表达式
 */
export function hasExpression(value: any): boolean {
  if (typeof value === 'string') {
    return value.includes('{{') && value.includes('}}');
  }
  return false;
}

/**
 * 提取表达式内容
 */
export function extractExpression(value: string): string | null {
  const match = value.match(/\{\{(.+?)\}\}/);
  return match ? match[1].trim() : null;
}
