/**
 * 平台检测和快捷键工具函数
 * 用于检测操作系统并提供平台特定的快捷键显示
 */

export type Platform = 'mac' | 'windows' | 'linux' | 'unknown';

/**
 * 检测是否为 macOS 系统
 */
export function isMac(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return false;
  }
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform) ||
         /Mac/.test(navigator.userAgent);
}

/**
 * 检测是否为 Windows 系统
 */
export function isWindows(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return false;
  }
  return /Win/.test(navigator.platform) || /Windows/.test(navigator.userAgent);
}

/**
 * 检测是否为 Linux 系统
 */
export function isLinux(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return false;
  }
  return /Linux/.test(navigator.platform) || /Linux/.test(navigator.userAgent);
}

/**
 * 获取当前平台类型
 */
export function getPlatform(): Platform {
  if (isMac()) return 'mac';
  if (isWindows()) return 'windows';
  if (isLinux()) return 'linux';
  return 'unknown';
}

/**
 * 获取当前平台的主修饰键符号
 * @returns Mac: '⌘', 其他: 'Ctrl'
 */
export function getModifierKey(): string {
  return isMac() ? '⌘' : 'Ctrl';
}

/**
 * 获取当前平台的主修饰键英文名称
 * @returns Mac: 'Cmd', 其他: 'Ctrl'
 */
export function getModifierKeyName(): string {
  return isMac() ? 'Cmd' : 'Ctrl';
}

/**
 * 格式化快捷键显示
 * @param key 按键（如 'S', '1', 'Esc'）
 * @param useModifier 是否使用修饰键（默认true）
 * @returns 格式化后的快捷键字符串（如 '⌘ + S' 或 'Ctrl + S'）
 */
export function formatShortcut(key: string, useModifier: boolean = true): string {
  if (!useModifier) {
    return key;
  }
  return `${getModifierKey()} + ${key}`;
}

/**
 * 检查键盘事件中是否按下了平台的主修饰键
 * Mac: Command键 (metaKey), Windows/Linux: Ctrl键 (ctrlKey)
 * @param event KeyboardEvent
 * @returns 是否按下了主修饰键
 */
export function isModifierPressed(event: KeyboardEvent): boolean {
  return isMac() ? event.metaKey : event.ctrlKey;
}
