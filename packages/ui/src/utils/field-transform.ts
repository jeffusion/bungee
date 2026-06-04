/**
 * 字段转换引擎
 *
 * 根据 FieldTransform 配置动态生成 parse 和 format 函数
 * 解决函数无法通过 JSON 序列化的问题
 */

export interface FieldTransform {
  type: 'split' | 'concat' | 'compute';
  separator?: string;
  fields?: string[];
}

export type ParseFunction = (value: any, allValues: Record<string, any>) => any | Record<string, any>;
export type FormatFunction = (value: any, allValues: Record<string, any>) => any;

/**
 * 根据转换配置创建 Parser 函数（UI → 数据）
 *
 * @param transform - 转换配置
 * @returns Parser 函数，将 UI 输入值转换为实际字段对象
 */
export function createParser(transform: FieldTransform): ParseFunction | null {
  switch (transform.type) {
    case 'split':
      return createSplitParser(transform);

    case 'concat':
      // TODO: 未来扩展
      return null;

    case 'compute':
      // TODO: 未来扩展
      return null;

    default:
      console.warn(`Unknown transform type: ${(transform as any).type}`);
      return null;
  }
}

/**
 * 根据转换配置创建 Formatter 函数（数据 → UI）
 *
 * @param transform - 转换配置
 * @returns Formatter 函数，将实际字段值合并为 UI 显示值
 */
export function createFormatter(transform: FieldTransform): FormatFunction | null {
  switch (transform.type) {
    case 'split':
      return createSplitFormatter(transform);

    case 'concat':
      // TODO: 未来扩展
      return null;

    case 'compute':
      // TODO: 未来扩展
      return null;

    default:
      console.warn(`Unknown transform type: ${(transform as any).type}`);
      return null;
  }
}

/**
 * 创建 split 类型的 Parser
 *
 * @example
 * Input: "anthropic-openai"
 * Config: { type: 'split', separator: '-', fields: ['from', 'to'] }
 * Output: { from: "anthropic", to: "openai" }
 */
function createSplitParser(transform: FieldTransform): ParseFunction {
  const { separator = '-', fields = [] } = transform;

  if (!separator || fields.length === 0) {
    throw new Error('Split transform requires separator and fields');
  }

  return (value: string) => {
    if (!value || typeof value !== 'string') {
      return {};
    }

    const parts = value.split(separator);
    const result: Record<string, any> = {};

    fields.forEach((fieldName, index) => {
      if (index < parts.length) {
        result[fieldName] = parts[index];
      }
    });

    return result;
  };
}

/**
 * 创建 split 类型的 Formatter
 *
 * @example
 * Input: { from: "anthropic", to: "openai" }
 * Config: { type: 'split', separator: '-', fields: ['from', 'to'] }
 * Output: "anthropic-openai"
 */
function createSplitFormatter(transform: FieldTransform): FormatFunction {
  const { separator = '-', fields = [] } = transform;

  if (!separator || fields.length === 0) {
    throw new Error('Split transform requires separator and fields');
  }

  return (_value: any, allValues: Record<string, any>) => {
    const parts = fields.map(fieldName => allValues[fieldName] || '');

    // 只有所有字段都有值时才返回拼接结果
    if (parts.every(part => part)) {
      return parts.join(separator);
    }

    return '';
  };
}

/**
 * 判断字段是否为虚拟字段
 * 虚拟字段：有 fieldTransform 配置的字段
 */
export function isVirtualField(field: any): boolean {
  return !!(field.fieldTransform);
}
