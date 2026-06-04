import { addMessages } from 'svelte-i18n';
import { api } from '$api/client';

/**
 * 从后端获取插件翻译
 */
export async function fetchPluginTranslations(): Promise<Record<string, any>> {
  try {
    return await api.get<Record<string, any>>('/plugin-translations');
  } catch (error) {
    console.error('Failed to fetch plugin translations:', error);
    return {};
  }
}

/**
 * 加载并注册插件翻译到 i18n 系统
 *
 * 该函数会：
 * 1. 调用后端 API 获取所有插件的翻译内容
 * 2. 使用 svelte-i18n 的 addMessages() 动态注册翻译
 * 3. 翻译会自动合并到现有的语言包中
 *
 * @example
 * ```typescript
 * // 在 App.svelte 的 onMount 中调用
 * await loadPluginTranslations();
 *
 * // 之后可以在组件中使用翻译
 * $_(plugins.ai-transformer.transformation.label')
 * ```
 */
export async function loadPluginTranslations(): Promise<void> {
  const translations = await fetchPluginTranslations();

  // 为每种语言注册翻译
  for (const [locale, messages] of Object.entries(translations)) {
    addMessages(locale, messages);
    console.debug(`[i18n] Plugin translations loaded for locale: ${locale}`);
  }
}
