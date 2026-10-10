import { addMessages } from 'svelte-i18n';
import { api } from '$api/client';
import { generatedPluginTranslations } from '$components/native-widgets/generated';

/** Register only the selected statically bundled provider, without an anonymous API request. */
export function registerStaticPluginTranslations(pluginName: string): void {
  for (const [locale, messages] of Object.entries(generatedPluginTranslations)) {
    const plugins: Record<string, Record<string, string>> = messages.plugins;
    if (Object.hasOwn(plugins, pluginName)) addMessages(locale, { plugins: { [pluginName]: plugins[pluginName] } });
  }
}

/**
 * 从后端获取插件翻译
 */
export async function fetchPluginTranslations(): Promise<Record<string, any>> {
  return api.get<Record<string, any>>('/plugin-translations', { preserveSessionOnUnauthorized: true });
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
 * $_(plugins.llm-protocol-adapter.sourceProtocol.label')
 * ```
 */
export async function loadPluginTranslations(isCurrent: () => boolean = () => true): Promise<boolean> {
  const translations = await fetchPluginTranslations();
  if (!isCurrent()) return false;

  // 为每种语言注册翻译
  for (const [locale, messages] of Object.entries(translations)) {
    addMessages(locale, messages);
    console.debug(`[i18n] Plugin translations loaded for locale: ${locale}`);
  }
  return true;
}
