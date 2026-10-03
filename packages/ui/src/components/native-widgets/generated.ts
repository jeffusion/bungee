/**
 * 自动生成的原生组件注册表
 *
 * 此文件由 scripts/generate-widget-registry.ts 自动生成，请勿手动修改。
 */

import type { ComponentType, SvelteComponent } from 'svelte';

import ChatgptAccountsPage from '@plugins/chatgpt-oauth/ui/AccountsPage.svelte';
import ChatgptQuotaWidget from '@plugins/chatgpt-oauth/ui/ChatgptQuotaWidget.svelte';
import KeyAccessKeyPolicy from '@plugins/key-access/ui/KeyPolicy.svelte';
import KeyRateLimitKeyPolicy from '@plugins/key-rate-limit/ui/KeyPolicy.svelte';
import LocalAccountsSettings from '@plugins/local-accounts/ui/Settings.svelte';
import LocalAccountsLogin from '@plugins/local-accounts/ui/Login.svelte';
import TokenBudgetKeyPolicy from '@plugins/token-budget/ui/KeyPolicy.svelte';
import TokenStatsChart from '@plugins/token-stats/ui/TokenStatsChart.svelte';
import TokenStatsSettings from '@plugins/token-stats/ui/TokenStatsSettings.svelte';
import TokenStatsMetric from '@plugins/token-stats/ui/TokenStatsMetric.svelte';
import TokenStatsPage from '@plugins/token-stats/ui/TokenStatsPage.svelte';

export const generatedWidgetRegistry: Record<string, ComponentType<SvelteComponent>> = {
  ChatgptAccountsPage,
  ChatgptQuotaWidget,
  KeyAccessKeyPolicy,
  KeyRateLimitKeyPolicy,
  LocalAccountsSettings,
  LocalAccountsLogin,
  TokenBudgetKeyPolicy,
  TokenStatsChart,
  TokenStatsSettings,
  TokenStatsMetric,
  TokenStatsPage,
};

export const componentSourceMap: Record<string, string> = {
  ChatgptAccountsPage: 'chatgpt-oauth',
  ChatgptQuotaWidget: 'chatgpt-oauth',
  KeyAccessKeyPolicy: 'key-access',
  KeyRateLimitKeyPolicy: 'key-rate-limit',
  LocalAccountsSettings: 'local-accounts',
  LocalAccountsLogin: 'local-accounts',
  TokenBudgetKeyPolicy: 'token-budget',
  TokenStatsChart: 'token-stats',
  TokenStatsSettings: 'token-stats',
  TokenStatsMetric: 'token-stats',
  TokenStatsPage: 'token-stats',
};
