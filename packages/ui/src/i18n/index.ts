import { register, init, getLocaleFromNavigator, locale } from 'svelte-i18n';

/**
 * i18n 配置和初始化
 *
 * 此模块在导入时立即初始化 i18n，确保在任何组件渲染之前
 * locale 已经设置完成，避免 "Cannot format a message" 错误
 */

// ===== 常量配置 =====

const DEFAULT_LOCALE = 'zh-CN';
const LOCALE_STORAGE_KEY = 'locale';

export const SUPPORTED_LOCALES = [
  { code: 'zh-CN', name: '中文' },
  { code: 'en', name: 'English' }
] as const;

// ===== 语言包注册 =====

register('zh-CN', () => import('./locales/zh-CN.json'));
register('en', () => import('./locales/en.json'));

// ===== 工具函数 =====

/**
 * 从 localStorage 获取保存的语言设置
 */
function getSavedLocale(): string | null {
  if (typeof localStorage !== 'undefined') {
    return localStorage.getItem(LOCALE_STORAGE_KEY);
  }
  return null;
}

/**
 * 保存语言设置到 localStorage
 */
export function saveLocale(localeCode: string): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(LOCALE_STORAGE_KEY, localeCode);
  }
}

/**
 * 切换应用语言
 */
export function switchLocale(localeCode: string): void {
  locale.set(localeCode);
  saveLocale(localeCode);
}

// ===== 导出 svelte-i18n stores =====

export { locale, _ } from 'svelte-i18n';

// ===== 模块初始化 =====

/**
 * 立即初始化 i18n
 *
 * 重要：这段代码在模块加载时立即执行，确保在任何组件
 * 使用 $_() 之前，locale 已经正确设置
 *
 * 优先级：localStorage > 浏览器语言 > 默认语言
 */
const savedLocale = getSavedLocale();
const browserLocale = getLocaleFromNavigator();
const initialLocale = savedLocale || browserLocale || DEFAULT_LOCALE;

init({
  fallbackLocale: DEFAULT_LOCALE,
  initialLocale: initialLocale
});