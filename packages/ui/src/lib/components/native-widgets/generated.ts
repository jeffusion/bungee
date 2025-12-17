/**
 * 自动生成的原生组件注册表
 *
 * ⚠️ 此文件由 scripts/generate-widget-registry.ts 自动生成
 * ⚠️ 请勿手动修改，修改将在下次构建时被覆盖
 *
 * 如需添加新组件，请在插件的 manifest.json 中声明 ui.components
 *
 * 生成时间: 2025-12-17T08:09:07.905Z
 */

import type { ComponentType, SvelteComponent } from 'svelte';

import TokenStatsChart from '@plugins/token-stats/ui/TokenStatsChart.svelte';

/**
 * 组件注册表（自动生成）
 * key: 组件名称（与 nativeWidgets.component 对应）
 * value: Svelte 组件
 */
export const generatedWidgetRegistry: Record<string, ComponentType<SvelteComponent>> = {
  TokenStatsChart,
};

/**
 * 组件来源映射（用于调试）
 */
export const componentSourceMap: Record<string, string> = {
  TokenStatsChart: 'token-stats',
};
