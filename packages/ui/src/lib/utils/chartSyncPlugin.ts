import type { Chart, Plugin } from 'chart.js';
import { getChartSyncStore, registerChart, unregisterChart, updateActiveIndex } from '../stores/chartSync';

/**
 * 创建图表联动插件
 * @param syncGroup 联动组名称
 * @returns Chart.js 插件实例
 */
export function createChartSyncPlugin(syncGroup: string): Plugin {
	let unsubscribe: (() => void) | null = null;

	// 生成唯一的插件 ID，确保每个图表实例都有独立的插件
	const pluginId = `chartSync-${syncGroup}-${Math.random().toString(36).substring(2, 11)}`;

	return {
		id: pluginId,

		/**
		 * 图表初始化后注册到联动组
		 */
		afterInit(chart: Chart) {
			// 注册图表到联动组
			registerChart(syncGroup, chart);

			// 订阅联动状态变化
			const store = getChartSyncStore(syncGroup);
			unsubscribe = store.subscribe((state) => {
				// 如果活动索引变化，且不是当前图表触发的，则更新 tooltip
				if (state.activeIndex !== null && state.sourceChartId !== chart.id) {
					showTooltipAtIndex(chart, state.activeIndex);
				} else if (state.activeIndex === null) {
					// 清除 tooltip
					hideTooltip(chart);
				}
			});
		},

		/**
		 * 处理鼠标事件
		 */
		afterEvent(chart: Chart, args: { event: any; changed?: boolean }) {
			const event = args.event;

			// 只处理鼠标移动和鼠标移出事件
			if (event.type === 'mousemove') {
				// 使用 Chart.js 官方推荐的方法获取悬停的元素
				// 这与图表的 interaction.mode: 'index' 配置完全一致
				const elements = chart.getElementsAtEventForMode(
					event,
					'index', // 使用 index 模式，匹配所有数据集在同一索引位置的点
					{ axis: 'x', intersect: false }, // 沿 x 轴匹配，不需要精确相交
					false // useFinalPosition
				);

				if (elements.length > 0) {
					// 获取第一个元素的索引（所有元素的索引相同）
					const index = elements[0].index;
					// 更新联动组的活动索引
					updateActiveIndex(syncGroup, index, chart.id);
					// 标记需要重绘，确保其他图表响应联动
					args.changed = true;
				}
			} else if (event.type === 'mouseout') {
				// 鼠标移出时清除联动
				updateActiveIndex(syncGroup, null, chart.id);
				// 标记需要重绘
				args.changed = true;
			}
		},

		/**
		 * 图表销毁时注销
		 */
		destroy(chart: Chart) {
			// 取消订阅
			if (unsubscribe) {
				unsubscribe();
				unsubscribe = null;
			}

			// 从联动组注销
			unregisterChart(syncGroup, chart);
		}
	};
}

/**
 * 在指定索引显示 tooltip
 */
function showTooltipAtIndex(chart: Chart, index: number) {
	if (!chart.data.datasets || chart.data.datasets.length === 0) return;

	// 构建 activeElements 数组
	const activeElements = chart.data.datasets.map((dataset, datasetIndex) => ({
		datasetIndex,
		index
	}));

	// 设置活动元素并更新 tooltip
	chart.tooltip?.setActiveElements(activeElements, { x: 0, y: 0 });
	chart.update('none'); // 使用 'none' 模式避免动画
}

/**
 * 隐藏 tooltip
 */
function hideTooltip(chart: Chart) {
	chart.tooltip?.setActiveElements([], { x: 0, y: 0 });
	chart.update('none');
}
