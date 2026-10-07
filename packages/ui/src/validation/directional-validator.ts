import type { DirectionalModificationRules } from '@jeffusion/bungee-types';
import { analyzeExpressionDependencies } from '../../../core/src/utils/expression-dependencies';
import type { ValidationError } from './route-validator';
import { _ } from '$i18n';
import { get } from 'svelte/store';

/** 与核心复用 AST 分析，避免编辑器和保存校验对表达式含义产生分歧。 */
export function validateDirectionalRules(policy: DirectionalModificationRules, prefix = ''): ValidationError[] {
  const errors: ValidationError[] = [];
  const path = (field: string) => prefix ? `${prefix}.${field}` : field;
  for (const direction of ['request', 'response'] as const) {
    const block = policy[direction];
    if (!block) continue;
    try { analyzeExpressionDependencies(block, direction); }
    catch { errors.push({ field: path(direction), message: get(_)('directional.invalidExpression') }); }
  }
  const formats = policy.response?.body_formats;
  if (formats !== undefined && (!Array.isArray(formats) || formats.some(format => !['json', 'sse-json'].includes(format))
    || new Set(formats).size !== formats.length)) {
    errors.push({ field: path('response.body_formats'), message: get(_)('directional.invalidFormats') });
  }
  if (policy.response && (formats === undefined || (Array.isArray(formats) && formats.includes('sse-json')))) {
    try {
      if (analyzeExpressionDependencies(policy.response.headers, 'response').responseBody) {
        errors.push({ field: path('response.headers'), message: get(_)('directional.sseHeaderDependency') });
      }
    } catch { /* expression failure already reported */ }
  }
  return errors;
}
