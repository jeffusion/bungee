/**
 * URL Adapter for Plugin Security
 *
 * 提供受保护的 URL 对象给 plugins，确保 plugins 只能修改白名单字段。
 */

import type { PluginUrl, ModifiableUrlFields } from '../../plugin.types';
import { logger } from '../../logger';

/**
 * 创建一个受保护的 URL 对象供 plugin 使用
 *
 * 实现思路：
 * 1. 使用 Proxy 拦截属性访问和赋值
 * 2. 只读字段：直接从源 URL 读取（protocol, host, hostname, port, href, origin）
 * 3. 可写字段：写入到独立的状态对象（pathname, search, hash）
 * 4. 修改后的值通过 getModifiedFields() 导出
 *
 * 安全特性：
 * - 编译时：TypeScript readonly 标记防止直接赋值
 * - 运行时：Proxy 拦截并警告/阻止非法修改
 * - 隔离性：每次调用返回独立的代理对象，保证请求隔离
 *
 * @param sourceUrl - 源 URL（upstream 的 URL）
 * @returns 受保护的 PluginUrl 对象（带 getModifiedFields 方法）
 *
 * @example
 * ```typescript
 * const url = new URL('https://api.example.com/v1/messages');
 * const pluginUrl = createPluginUrl(url);
 *
 * // 可以读取所有字段
 * console.log(pluginUrl.host); // 'api.example.com'
 * console.log(pluginUrl.pathname); // '/v1/messages'
 *
 * // 可以修改白名单字段
 * pluginUrl.pathname = '/v1/chat/completions';
 *
 * // 无法修改只读字段（运行时警告 + 阻止）
 * pluginUrl.host = 'evil.com'; // ⚠️ Warning + Blocked
 *
 * // 获取修改后的字段
 * const modifications = pluginUrl.getModifiedFields();
 * // { pathname: '/v1/chat/completions', search: '', hash: '' }
 * ```
 */
export function createPluginUrl(
  sourceUrl: URL
): PluginUrl & { getModifiedFields(): ModifiableUrlFields } {
  // 存储 plugin 的修改（白名单字段）
  const modifications: ModifiableUrlFields = {
    pathname: sourceUrl.pathname,
    search: sourceUrl.search,
    hash: sourceUrl.hash,
  };

  // 只读字段列表（不允许 plugin 修改）
  const readonlyFields = new Set<string>([
    'href',
    'protocol',
    'host',
    'hostname',
    'port',
    'origin',
  ]);

  // 可修改字段列表（白名单）
  const modifiableFields = new Set<string>(['pathname', 'search', 'hash']);

  const handler: ProxyHandler<any> = {
    /**
     * 拦截属性读取
     */
    get(target, prop: string) {
      // 特殊方法：获取修改后的字段
      if (prop === 'getModifiedFields') {
        return () => ({ ...modifications });
      }

      // 可修改字段：返回修改后的值
      if (modifiableFields.has(prop)) {
        return modifications[prop as keyof ModifiableUrlFields];
      }

      // 只读字段：从源 URL 读取
      if (readonlyFields.has(prop)) {
        return sourceUrl[prop as keyof URL];
      }

      // 其他字段：阻止访问（防止意外依赖）
      logger.warn(
        {
          field: prop,
          sourceUrl: sourceUrl.href,
        },
        `[PluginUrl] Attempt to access unsupported field: ${prop}`
      );
      return undefined;
    },

    /**
     * 拦截属性赋值
     */
    set(target, prop: string, value) {
      // 只允许修改白名单字段
      if (modifiableFields.has(prop)) {
        modifications[prop as keyof ModifiableUrlFields] = value;
        logger.debug(
          {
            field: prop,
            value,
            sourceUrl: sourceUrl.href,
          },
          `[PluginUrl] Modified field: ${prop}`
        );
        return true;
      }

      // 尝试修改只读字段：警告并阻止
      if (readonlyFields.has(prop)) {
        logger.warn(
          {
            field: prop,
            attemptedValue: value,
            currentValue: sourceUrl[prop as keyof URL],
            sourceUrl: sourceUrl.href,
          },
          `[PluginUrl] Attempt to modify readonly field "${prop}" (blocked for security)`
        );
        return false; // 阻止赋值
      }

      // 其他字段：阻止赋值
      logger.warn(
        {
          field: prop,
          attemptedValue: value,
          sourceUrl: sourceUrl.href,
        },
        `[PluginUrl] Attempt to set unsupported field: ${prop}`
      );
      return false;
    },

    /**
     * 拦截 in 操作符（如 'pathname' in pluginUrl）
     */
    has(target, prop: string) {
      return (
        prop === 'getModifiedFields' ||
        modifiableFields.has(prop) ||
        readonlyFields.has(prop)
      );
    },

    /**
     * 拦截 Object.keys(), Object.getOwnPropertyNames() 等
     */
    ownKeys(target) {
      return [
        ...Array.from(modifiableFields),
        ...Array.from(readonlyFields),
        'getModifiedFields',
      ];
    },

    /**
     * 拦截 Object.getOwnPropertyDescriptor()
     */
    getOwnPropertyDescriptor(target, prop: string) {
      if (
        prop === 'getModifiedFields' ||
        modifiableFields.has(prop) ||
        readonlyFields.has(prop)
      ) {
        return {
          configurable: true,
          enumerable: true,
          writable: modifiableFields.has(prop), // 只有白名单字段可写
        };
      }
      return undefined;
    },
  };

  return new Proxy({} as any, handler);
}
