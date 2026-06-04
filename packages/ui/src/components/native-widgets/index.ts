/**
 * 原生仪表板组件注册表
 *
 * 插件可以通过 manifest.json 的 contributes.nativeWidgets 声明使用这些组件，
 * 组件将直接渲染为 Svelte 组件（非 iframe），可以复用主应用的图表库和样式。
 *
 * 组件注册流程：
 * 1. 在插件的 manifest.json 中声明 ui.components
 * 2. 运行 `bun scripts/generate-widget-registry.ts` 生成注册表
 * 3. 在 contributes.nativeWidgets 中引用组件名称
 *
 * 安全说明：
 * - 只有在注册表中声明的组件才能被插件使用
 * - 插件只能通过组件名称引用，不能执行任意代码
 */

import type { ComponentType, SvelteComponent } from 'svelte';

// 导入自动生成的组件注册表
import { generatedWidgetRegistry, componentSourceMap } from './generated';

/**
 * 组件注册表
 * 合并自动生成的组件和手动添加的组件（如有需要）
 */
export const nativeWidgetRegistry: Record<string, ComponentType<SvelteComponent>> = {
  ...generatedWidgetRegistry,
  // 可在此添加额外的手动注册组件
};

/**
 * 获取原生组件
 * @param name 组件名称
 * @returns Svelte 组件或 null
 */
export function getNativeWidget(name: string): ComponentType<SvelteComponent> | null {
  return nativeWidgetRegistry[name] || null;
}

/**
 * 检查组件是否存在
 * @param name 组件名称
 */
export function hasNativeWidget(name: string): boolean {
  return name in nativeWidgetRegistry;
}

/**
 * 获取所有可用的组件名称
 */
export function getAvailableWidgets(): string[] {
  return Object.keys(nativeWidgetRegistry);
}

/**
 * 获取组件的来源插件名称
 * @param name 组件名称
 */
export function getWidgetSource(name: string): string | undefined {
  return componentSourceMap[name];
}

// 导出组件来源映射
export { componentSourceMap };
