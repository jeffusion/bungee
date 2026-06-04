import { writable } from 'svelte/store';
import type { Chart } from 'chart.js';

/**
 * 图表联动状态接口
 */
interface ChartSyncState {
	activeIndex: number | null; // 当前活动的数据索引
	sourceChartId?: string; // 触发联动的图表 ID
}

/**
 * 联动组状态管理
 * 每个联动组有独立的活动索引状态
 */
const syncGroups = new Map<string, ReturnType<typeof writable<ChartSyncState>>>();

/**
 * 图表实例注册表
 * 用于管理每个联动组中的图表实例
 */
const chartRegistry = new Map<string, Set<Chart>>();

/**
 * 获取或创建指定联动组的 store
 */
export function getChartSyncStore(syncGroup: string) {
	if (!syncGroups.has(syncGroup)) {
		syncGroups.set(
			syncGroup,
			writable<ChartSyncState>({
				activeIndex: null
			})
		);
	}
	return syncGroups.get(syncGroup)!;
}

/**
 * 注册图表到联动组
 */
export function registerChart(syncGroup: string, chart: Chart) {
	if (!chartRegistry.has(syncGroup)) {
		chartRegistry.set(syncGroup, new Set());
	}
	chartRegistry.get(syncGroup)!.add(chart);
}

/**
 * 从联动组注销图表
 */
export function unregisterChart(syncGroup: string, chart: Chart) {
	const charts = chartRegistry.get(syncGroup);
	if (charts) {
		charts.delete(chart);
		if (charts.size === 0) {
			chartRegistry.delete(syncGroup);
			// 清理空的 store
			syncGroups.delete(syncGroup);
		}
	}
}

/**
 * 获取联动组中的所有图表
 */
export function getChartsInGroup(syncGroup: string): Chart[] {
	const charts = chartRegistry.get(syncGroup);
	return charts ? Array.from(charts) : [];
}

/**
 * 更新联动组的活动索引
 */
export function updateActiveIndex(syncGroup: string, index: number | null, sourceChartId?: string) {
	const store = getChartSyncStore(syncGroup);
	store.set({
		activeIndex: index,
		sourceChartId
	});
}
