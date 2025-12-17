/**
 * 插件 SDK - 供插件 UI 组件使用的工具集
 *
 * 使用方式：
 * import { chartTheme, api, _ } from '@bungee/plugin-sdk';
 */

// Chart 相关
export { chartTheme } from '../stores/chartTheme';
export {
  createTitleConfig,
  createLegendConfig,
  createScaleConfig,
  createTooltipConfig
} from '../utils/chartConfig';

// API 客户端
export { api } from '../api/client';

// 国际化
export { _ } from '../i18n';

// 类型
export type { TimeRange, StatsHistoryV2 } from '../types';

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
