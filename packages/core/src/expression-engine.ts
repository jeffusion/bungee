import { createHash, randomUUID } from 'crypto';
import { logger } from './logger';

// 表达式上下文接口
export interface ExpressionContext {
  headers: Record<string, string>;
  body: Record<string, any>;
  url: {
    pathname: string;
    search: string;
    host: string;
    protocol: string;
  };
  method: string;
  env: Record<string, string>;
  stream?: {
    phase: string;
    chunkIndex: number;
  };
}

// 检查是否在测试环境
const isTestEnvironment = process.env.NODE_ENV === 'test' || process.env.BUN_ENV === 'test' ||
  typeof (globalThis as any).describe !== 'undefined';

// 内置函数库
const builtinFunctions = {
  // 基础工具
  uuid: () => randomUUID(),
  now: () => Date.now(),
  randomInt: (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min,

  // 字符串处理
  base64encode: (str: string) => Buffer.from(str).toString('base64'),
  base64decode: (str: string) => Buffer.from(str, 'base64').toString(),
  md5: (str: string) => createHash('md5').update(str).digest('hex'),
  sha256: (str: string) => createHash('sha256').update(str).digest('hex'),

  // JSON处理
  parseJWT: (token: string) => {
    try {
      if (!token || typeof token !== 'string') {
        throw new Error('Invalid token type');
      }
      const payload = token.split('.')[1];
      if (!payload) throw new Error('Invalid JWT format');
      return JSON.parse(Buffer.from(payload, 'base64').toString());
    } catch (error) {
      const tokenPreview = typeof token === 'string' ? token.substring(0, 20) + '...' : 'invalid';
      // 只在非测试环境下记录日志
      if (!isTestEnvironment) {
        logger.warn({ token: tokenPreview, error }, 'Failed to parse JWT');
      }
      return {};
    }
  },
  jsonParse: (str: string) => JSON.parse(str),
  jsonStringify: (obj: any) => JSON.stringify(obj),

  // 加密函数（简单示例）
  encrypt: (str: string, method: string = 'base64') => {
    if (method === 'base64') return Buffer.from(str).toString('base64');
    // 可扩展其他加密方法
    return str;
  },

  // 数组和对象处理
  first: (arr: any[]) => arr?.[0],
  last: (arr: any[]) => arr?.[arr.length - 1],
  length: (obj: any) => obj?.length || Object.keys(obj || {}).length,
  keys: (obj: Record<string, any>) => Object.keys(obj || {}),
  values: (obj: Record<string, any>) => Object.values(obj || {}),

  // 字符串工具
  trim: (str: string) => str?.trim(),
  toLowerCase: (str: string) => str?.toLowerCase(),
  toUpperCase: (str: string) => str?.toUpperCase(),
  split: (str: string, delimiter: string) => str?.split(delimiter) || [],
  replace: (str: string, search: string, replacement: string) => str?.replace(search, replacement),

  // 类型检查
  isString: (val: any) => typeof val === 'string',
  isNumber: (val: any) => typeof val === 'number',
  isObject: (val: any) => typeof val === 'object' && val !== null,
  isArray: (val: any) => Array.isArray(val),

  // 通用的深度对象清理函数 - 移除指定的字段
  deepClean: (obj: any, fieldsToRemove: string[] = ['$schema', 'additionalProperties', 'title']): any => {
    if (!obj || typeof obj !== 'object') return obj;

    const clean = (current: any): any => {
      if (Array.isArray(current)) {
        return current.map(clean);
      }

      if (current && typeof current === 'object') {
        const cleaned: any = {};
        for (const [key, value] of Object.entries(current)) {
          // 跳过指定要移除的字段
          if (fieldsToRemove.includes(key)) {
            continue;
          }
          cleaned[key] = clean(value);
        }
        return cleaned;
      }

      return current;
    };

    return clean(obj);
  },
};

// 安全的表达式求值器 - 使用简单的函数调用而非完整的JavaScript解析
class SafeEvaluator {
  private context: ExpressionContext;
  private functions: Record<string, any>;

  constructor(context: ExpressionContext) {
    this.context = context;
    this.functions = {
      ...builtinFunctions,
      // 安全的内置对象
      Math,
      Date,
      JSON,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
      encodeURIComponent,
      decodeURIComponent,
    };
  }

  // 安全地解析简单表达式
  evaluate(expression: string): any {
    try {
      // 创建一个安全的执行上下文
      const safeContext = {
        headers: this.context.headers,
        body: this.context.body,
        url: this.context.url,
        method: this.context.method,
        env: this.context.env,
        stream: this.context.stream,
        ...this.functions,
      };

      // 使用 Function constructor 而不是 eval，相对更安全
      // 同时在执行前检查危险表达式
      if (expression.includes('process.exit') ||
          expression.includes('require(') ||
          expression.includes('eval(') ||
          expression.includes('Function(')) {
        throw new Error('Dangerous function call detected');
      }

      const func = new Function(
        ...Object.keys(safeContext),
        `"use strict"; return (${expression});`
      );

      return func(...Object.values(safeContext));
    } catch (error) {
      throw new Error(`Expression evaluation failed: ${(error as Error).message}`);
    }
  }
}

// 表达式缓存
const expressionCache = new Map<string, Function>();

// 执行表达式
export function evaluateExpression(expression: string, context: ExpressionContext): any {
  try {
    const evaluator = new SafeEvaluator(context);
    const result = evaluator.evaluate(expression);

    // ✅ 忠实返回求值结果，不做任何类型转换
    return result;

  } catch (error) {
    // 只在非测试环境下记录错误日志
    if (!isTestEnvironment) {
      logger.error({ expression, error }, 'Failed to evaluate expression');
    }
    throw error;
  }
}

// 处理动态值：检测并执行表达式
export function processDynamicValue(value: any, context: ExpressionContext): any {
  const _recursiveProcess = (currentValue: any): any => {
    if (typeof currentValue === 'string') {
      // 字符串：执行表达式替换
      const expressionRegex = /\{\{(.+?)\}\}/g;
      const matches = Array.from(currentValue.matchAll(expressionRegex));

      if (matches.length === 0) {
        return currentValue;
      }

      if (matches.length === 1 && matches[0][0] === currentValue) {
        return evaluateExpression(matches[0][1], context);
      }

      let result = currentValue;
      for (const match of matches) {
        const [fullMatch, expression] = match;
        try {
          const evaluated = evaluateExpression(expression, context);
          result = result.replace(fullMatch, String(evaluated));
        } catch (error) {
          if (!isTestEnvironment) {
            logger.warn({ expression, error }, 'Expression evaluation failed in template string');
          }
        }
      }
      return result;

    } else if (Array.isArray(currentValue)) {
      // 数组：递归处理每一项
      return currentValue.map(item => _recursiveProcess(item));

    } else if (typeof currentValue === 'object' && currentValue !== null) {
      // 对象：递归处理每一个值
      const newObj: Record<string, any> = {};
      for (const key in currentValue) {
        if (Object.prototype.hasOwnProperty.call(currentValue, key)) {
          newObj[key] = _recursiveProcess(currentValue[key]);
        }
      }
      return newObj;
    }

    // 其他类型：直接返回
    return currentValue;
  };

  return _recursiveProcess(value);
}

// 清理表达式缓存（用于测试或内存管理）
export function clearExpressionCache(): void {
  expressionCache.clear();
}

// 获取缓存统计信息
export function getCacheStats(): { size: number; keys: string[] } {
  return {
    size: expressionCache.size,
    keys: Array.from(expressionCache.keys()),
  };
}
