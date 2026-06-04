/**
 * 获取插件的翻译文本（支持翻译键）
 *
 * 翻译键格式：包含 `.` 且不包含空格
 * 系统会自动添加 `plugins.{pluginName}` 前缀
 *
 * @param text 原始文本或翻译键
 * @param pluginName 插件名称
 * @param _ i18n 翻译函数
 * @returns 翻译后的文本
 *
 * @example
 * // 插件定义：metadata.name: 'metadata.name'
 * // 翻译文件：plugins.ai-transformer.metadata.name: "AI Transformer"
 * getPluginText('metadata.name', 'ai-transformer', $_) // => "AI Transformer"
 *
 * @example
 * // 非翻译键，直接返回
 * getPluginText('My Plugin', 'ai-transformer', $_) // => "My Plugin"
 */
export function getPluginText(
  text: string | undefined,
  pluginName: string,
  _: (key: string, options?: any) => string
): string {
  if (!text) return '';

  if (text.startsWith('plugins.')) {
    return _(text, { default: text });
  }

  // 检测是否为翻译键（包含 `.` 且不包含空格）
  const isTranslationKey = text.includes('.') && !text.includes(' ');

  if (isTranslationKey) {
    const key = `plugins.${pluginName}.${text}`;
    // 使用 default 选项，如果翻译不存在则返回原始文本
    return _(key, { default: text });
  }

  return text;
}
