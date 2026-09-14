/**
 * 插件 SDK - 供插件 UI 组件使用的工具集
 *
 * 使用方式：
 * import { chartTheme, api, _ } from '@bungee/plugin-sdk';
 */

// Chart 相关
export { chartTheme } from '$stores/chartTheme';
export {
  createTitleConfig,
  createLegendConfig,
  createScaleConfig,
  createTooltipConfig
} from '$utils/chartConfig';

// API 客户端。沙箱 iframe 中的控制请求只走 MessagePort，不携带 dashboard token。
export { api } from '$api/client';
import { requestPluginControl as requestDashboardControl } from '$api/client';
import { requestPluginHostAction } from './host-messages';

export function requestPluginControl<T>(
  plugin: string,
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  if (typeof window !== 'undefined' && window.parent !== window) {
    return requestPluginHostAction<T>('control', { path, method, body }, signal);
  }
  return requestDashboardControl<T>(plugin, path, method, body, signal);
}

export { requestPluginHostAction } from './host-messages';

// 国际化
export { _ } from '$i18n';

// 类型
export type { TimeRange, StatsHistoryV2 } from '$types';

// Svelte 组件库
export { Bar, Line, Pie, Doughnut } from 'svelte-chartjs';
export {
  Chart as ChartJS,
  BarElement,
  LineElement,
  PointElement,
  ArcElement,
  CategoryScale,
  LinearScale,
  TimeScale,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js';
export type { ChartData, ChartOptions } from 'chart.js';
