/**
 * 插件配置验证器
 *
 * 基于 PluginConfigField schema 进行运行时验证
 */

import type { PluginConfigField, ValidationRule } from '../plugin.types';
import { logger } from '../logger';

/**
 * 验证结果
 */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

/**
 * 验证错误
 */
export interface ValidationError {
  field: string;
  message: string;
  value?: any;
}

/**
 * 验证插件配置
 *
 * @param config 插件配置对象
 * @param schema 配置 schema
 * @param pluginName 插件名称（用于日志）
 * @returns 验证结果
 */
export function validatePluginConfig(
  config: Record<string, any>,
  schema: PluginConfigField[],
  pluginName?: string
): ValidationResult {
  const errors: ValidationError[] = [];

  for (const field of schema) {
    const value = config[field.name];
    const fieldErrors = validateField(field, value, field.name);
    errors.push(...fieldErrors);
  }

  if (errors.length > 0 && pluginName) {
    logger.warn(
      {
        pluginName,
        errorCount: errors.length,
        errors: errors.map(e => `${e.field}: ${e.message}`)
      },
      'Plugin config validation failed'
    );
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * 验证单个字段
 */
function validateField(
  field: PluginConfigField,
  value: any,
  path: string
): ValidationError[] {
  const errors: ValidationError[] = [];

  // 必填检查
  if (field.required && (value === undefined || value === null || value === '')) {
    errors.push({
      field: path,
      message: `Required field is missing`,
      value
    });
    return errors; // 必填字段缺失，跳过其他验证
  }

  // 如果值为空且非必填，跳过验证
  if (value === undefined || value === null) {
    return errors;
  }

  // 类型检查
  const typeError = validateType(field, value, path);
  if (typeError) {
    errors.push(typeError);
    return errors; // 类型错误，跳过其他验证
  }

  // 验证规则检查
  if (field.validation) {
    const validationErrors = validateRules(field.validation, value, path, field.type);
    errors.push(...validationErrors);
  }

  // select/multiselect 选项检查
  if ((field.type === 'select' || field.type === 'multiselect') && field.options) {
    const optionErrors = validateOptions(field, value, path);
    errors.push(...optionErrors);
  }

  // 嵌套对象验证
  if (field.type === 'object' && field.properties && typeof value === 'object') {
    for (const prop of field.properties) {
      const propValue = value[prop.name];
      const propErrors = validateField(prop, propValue, `${path}.${prop.name}`);
      errors.push(...propErrors);
    }
  }

  // 数组验证
  if (field.type === 'array' && field.items && Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const itemErrors = validateField(field.items, value[i], `${path}[${i}]`);
      errors.push(...itemErrors);
    }
  }

  return errors;
}

/**
 * 类型验证
 */
function validateType(
  field: PluginConfigField,
  value: any,
  path: string
): ValidationError | null {
  switch (field.type) {
    case 'string':
    case 'textarea':
      if (typeof value !== 'string') {
        return { field: path, message: `Expected string, got ${typeof value}`, value };
      }
      break;

    case 'number':
      if (typeof value !== 'number' || isNaN(value)) {
        return { field: path, message: `Expected number, got ${typeof value}`, value };
      }
      break;

    case 'boolean':
      if (typeof value !== 'boolean') {
        return { field: path, message: `Expected boolean, got ${typeof value}`, value };
      }
      break;

    case 'select':
      if (typeof value !== 'string') {
        return { field: path, message: `Expected string for select, got ${typeof value}`, value };
      }
      break;

    case 'multiselect':
      if (!Array.isArray(value)) {
        return { field: path, message: `Expected array for multiselect, got ${typeof value}`, value };
      }
      break;

    case 'json':
      // JSON 可以是任意类型，但如果是字符串需要是有效 JSON
      if (typeof value === 'string') {
        try {
          JSON.parse(value);
        } catch {
          return { field: path, message: `Invalid JSON string`, value };
        }
      }
      break;

    case 'object':
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { field: path, message: `Expected object, got ${Array.isArray(value) ? 'array' : typeof value}`, value };
      }
      break;

    case 'array':
      if (!Array.isArray(value)) {
        return { field: path, message: `Expected array, got ${typeof value}`, value };
      }
      break;
  }

  return null;
}

/**
 * 验证规则检查
 */
function validateRules(
  rules: ValidationRule,
  value: any,
  path: string,
  fieldType: string
): ValidationError[] {
  const errors: ValidationError[] = [];

  // 正则验证（仅字符串）
  if (rules.pattern && typeof value === 'string') {
    try {
      const regex = new RegExp(rules.pattern);
      if (!regex.test(value)) {
        errors.push({
          field: path,
          message: rules.message || `Value does not match pattern: ${rules.pattern}`,
          value
        });
      }
    } catch {
      logger.warn({ pattern: rules.pattern, path }, 'Invalid regex pattern in validation rule');
    }
  }

  // 最小值/最小长度
  if (rules.min !== undefined) {
    if (fieldType === 'number' && typeof value === 'number') {
      if (value < rules.min) {
        errors.push({
          field: path,
          message: rules.message || `Value must be at least ${rules.min}`,
          value
        });
      }
    } else if ((fieldType === 'string' || fieldType === 'textarea') && typeof value === 'string') {
      if (value.length < rules.min) {
        errors.push({
          field: path,
          message: rules.message || `Length must be at least ${rules.min}`,
          value
        });
      }
    } else if (fieldType === 'array' && Array.isArray(value)) {
      if (value.length < rules.min) {
        errors.push({
          field: path,
          message: rules.message || `Array must have at least ${rules.min} items`,
          value
        });
      }
    }
  }

  // 最大值/最大长度
  if (rules.max !== undefined) {
    if (fieldType === 'number' && typeof value === 'number') {
      if (value > rules.max) {
        errors.push({
          field: path,
          message: rules.message || `Value must be at most ${rules.max}`,
          value
        });
      }
    } else if ((fieldType === 'string' || fieldType === 'textarea') && typeof value === 'string') {
      if (value.length > rules.max) {
        errors.push({
          field: path,
          message: rules.message || `Length must be at most ${rules.max}`,
          value
        });
      }
    } else if (fieldType === 'array' && Array.isArray(value)) {
      if (value.length > rules.max) {
        errors.push({
          field: path,
          message: rules.message || `Array must have at most ${rules.max} items`,
          value
        });
      }
    }
  }

  return errors;
}

/**
 * 选项验证
 */
function validateOptions(
  field: PluginConfigField,
  value: any,
  path: string
): ValidationError[] {
  const errors: ValidationError[] = [];
  const validValues = new Set(field.options!.map(opt => opt.value));

  if (field.type === 'select') {
    if (!validValues.has(value)) {
      errors.push({
        field: path,
        message: `Invalid option: ${value}. Valid options: ${Array.from(validValues).join(', ')}`,
        value
      });
    }
  } else if (field.type === 'multiselect' && Array.isArray(value)) {
    for (const item of value) {
      if (!validValues.has(item)) {
        errors.push({
          field: path,
          message: `Invalid option in multiselect: ${item}. Valid options: ${Array.from(validValues).join(', ')}`,
          value: item
        });
      }
    }
  }

  return errors;
}

/**
 * 应用默认值
 *
 * @param config 配置对象
 * @param schema 配置 schema
 * @returns 应用默认值后的配置
 */
export function applyDefaults(
  config: Record<string, any>,
  schema: PluginConfigField[]
): Record<string, any> {
  const result = { ...config };

  for (const field of schema) {
    if (result[field.name] === undefined && field.default !== undefined) {
      result[field.name] = field.default;
    }

    // 递归处理嵌套对象
    if (field.type === 'object' && field.properties && typeof result[field.name] === 'object') {
      result[field.name] = applyDefaults(result[field.name], field.properties);
    }
  }

  return result;
}
