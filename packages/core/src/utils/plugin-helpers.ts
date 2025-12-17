/**
 * 插件系统辅助函数
 *
 * 提取自各模块的通用逻辑，减少代码重复
 */

import type { PluginConfig } from '@jeffusion/bungee-types';
import type { PluginTranslations, PluginConstructor } from '../plugin.types';
import type { LoadedPluginManifest } from '../plugin.types';

/**
 * 标准化插件配置
 *
 * 将字符串形式的插件配置转换为对象形式
 *
 * @param config 插件配置（字符串或对象）
 * @returns 标准化后的插件配置对象
 *
 * @example
 * normalizePluginConfig('my-plugin')
 * // => { name: 'my-plugin' }
 *
 * normalizePluginConfig({ name: 'my-plugin', options: { foo: 'bar' } })
 * // => { name: 'my-plugin', options: { foo: 'bar' } }
 */
export function normalizePluginConfig(config: PluginConfig | string): PluginConfig {
  return typeof config === 'string' ? { name: config } : config;
}

/**
 * 收集插件翻译内容
 *
 * 优先从 manifest 获取翻译，回退到插件类的静态属性
 *
 * @param manifest 插件 manifest（可选）
 * @param PluginClass 插件构造函数
 * @returns 翻译内容，如果没有则返回 undefined
 */
export function collectPluginTranslations(
  manifest: LoadedPluginManifest | null | undefined,
  PluginClass: PluginConstructor | { translations?: PluginTranslations }
): PluginTranslations | undefined {
  const translations = manifest?.translations || PluginClass.translations;

  // 检查是否为有效的翻译对象
  if (translations && typeof translations === 'object' && Object.keys(translations).length > 0) {
    return translations;
  }

  return undefined;
}

/**
 * 按优先级排序插件实例
 *
 * 数字越小优先级越高（priority 0 在 priority 10 之前执行）
 *
 * @param instances 插件实例数组
 */
export function sortByPriority<T extends { priority: number }>(instances: T[]): void {
  instances.sort((a, b) => a.priority - b.priority);
}
