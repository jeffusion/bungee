/**
 * 自动生成的原生组件注册表
 *
 * 此文件由 scripts/generate-widget-registry.ts 自动生成，请勿手动修改。
 */

import type { ComponentType, SvelteComponent } from 'svelte';

import ChatgptAccountsPage from '@plugins/chatgpt-oauth/ui/AccountsPage.svelte';
import ChatgptQuotaWidget from '@plugins/chatgpt-oauth/ui/ChatgptQuotaWidget.svelte';
import TokenStatsChart from '@plugins/token-stats/ui/TokenStatsChart.svelte';
import TokenStatsSettings from '@plugins/token-stats/ui/TokenStatsSettings.svelte';

export const generatedWidgetRegistry: Record<string, ComponentType<SvelteComponent>> = {
  ChatgptAccountsPage,
  ChatgptQuotaWidget,
  TokenStatsChart,
  TokenStatsSettings,
};

export const componentSourceMap: Record<string, string> = {
  ChatgptAccountsPage: 'chatgpt-oauth',
  ChatgptQuotaWidget: 'chatgpt-oauth',
  TokenStatsChart: 'token-stats',
  TokenStatsSettings: 'token-stats',
};
