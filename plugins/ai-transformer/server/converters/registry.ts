/**
 * Transformer Registry
 *
 * 管理所有 AI 格式转换器的注册和查找
 */

import type { AIConverter, TransformDirection } from './base';
import { logger } from '../../../../packages/core/src/logger';

/**
 * 转换器注册表
 *
 * 提供转换器的注册、查找和管理功能
 */
export class TransformerRegistry {
  private static converters = new Map<TransformDirection, new () => AIConverter>();

  /**
   * 注册一个转换器
   *
   * @param from - 源格式标识符
   * @param to - 目标格式标识符
   * @param ConverterClass - 转换器类构造函数
   */
  static register(from: string, to: string, ConverterClass: new () => AIConverter): void {
    const key: TransformDirection = `${from}-${to}`;

    if (this.converters.has(key)) {
      logger.warn({ from, to }, 'Converter already registered, overwriting');
    }

    this.converters.set(key, ConverterClass);
    logger.debug({ from, to, key }, 'Converter registered');
  }

  /**
   * 获取指定方向的转换器实例
   *
   * @param from - 源格式标识符
   * @param to - 目标格式标识符
   * @returns 转换器实例
   * @throws 如果未找到对应的转换器
   */
  static get(from: string, to: string): AIConverter {
    const key: TransformDirection = `${from}-${to}`;
    const ConverterClass = this.converters.get(key);

    if (!ConverterClass) {
      const availableConverters = Array.from(this.converters.keys()).join(', ');
      throw new Error(
        `No converter found for "${from}" → "${to}".\n` +
        `Available converters: ${availableConverters || 'none'}\n\n` +
        `Tip: Make sure the converter is registered before using ai-transformer plugin.`
      );
    }

    return new ConverterClass();
  }

  /**
   * 检查是否存在指定方向的转换器
   *
   * @param from - 源格式标识符
   * @param to - 目标格式标识符
   * @returns 是否存在转换器
   */
  static has(from: string, to: string): boolean {
    const key: TransformDirection = `${from}-${to}`;
    return this.converters.has(key);
  }

  /**
   * 获取所有已注册的转换器方向
   *
   * @returns 转换方向数组
   */
  static getAllDirections(): TransformDirection[] {
    return Array.from(this.converters.keys());
  }

  /**
   * 获取所有已注册的源格式
   *
   * @returns 源格式数组（去重）
   */
  static getAllFromFormats(): string[] {
    const formats = new Set<string>();
    for (const key of this.converters.keys()) {
      const [from] = key.split('-');
      formats.add(from);
    }
    return Array.from(formats);
  }

  /**
   * 获取所有已注册的目标格式
   *
   * @returns 目标格式数组（去重）
   */
  static getAllToFormats(): string[] {
    const formats = new Set<string>();
    for (const key of this.converters.keys()) {
      const [, to] = key.split('-');
      formats.add(to);
    }
    return Array.from(formats);
  }

  /**
   * 清空所有已注册的转换器（主要用于测试）
   */
  static clear(): void {
    this.converters.clear();
    logger.debug('All converters cleared');
  }
}
