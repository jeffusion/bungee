/**
 * 稳定 Hash 工具
 *
 * 用于生成对象的稳定哈希值，解决 JSON.stringify 属性顺序不稳定的问题
 */

import crypto from 'crypto';

/**
 * 递归排序对象的所有键
 * @param obj 要排序的对象
 * @returns 排序后的对象
 */
function sortObjectKeys(obj: any): any {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(sortObjectKeys);
  }

  if (typeof obj === 'object') {
    const sorted: Record<string, any> = {};
    const keys = Object.keys(obj).sort();
    for (const key of keys) {
      sorted[key] = sortObjectKeys(obj[key]);
    }
    return sorted;
  }

  return obj;
}

/**
 * 生成对象的稳定 hash（属性顺序无关）
 *
 * @param obj 要 hash 的对象
 * @returns 16 字符的 hash 字符串
 *
 * @example
 * stableHash({ b: 2, a: 1 }) === stableHash({ a: 1, b: 2 }) // true
 */
export function stableHash(obj: any): string {
  try {
    const sorted = sortObjectKeys(obj);
    const str = JSON.stringify(sorted);
    return crypto.createHash('sha256').update(str).digest('hex').slice(0, 16);
  } catch (error) {
    // 处理循环引用等异常情况，回退到时间戳 + 随机数
    return `fallback_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * 生成 PluginHandler 的唯一标识
 *
 * @param pluginName 插件名称
 * @param config 插件配置
 * @returns 唯一标识字符串
 *
 * @example
 * getHandlerKey('my-plugin', { ttl: 3600 })
 * // => 'my-plugin:a1b2c3d4e5f6g7h8'
 */
export function getHandlerKey(pluginName: string, config: any): string {
  const configHash = stableHash(config || {});
  return `${pluginName}:${configHash}`;
}
