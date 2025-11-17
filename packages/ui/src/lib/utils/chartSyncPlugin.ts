import type { Chart, Plugin } from 'chart.js';
import { getChartSyncStore, registerChart, unregisterChart, updateActiveIndex } from '../stores/chartSync';

/**
 * 创建图表联动插件
 * @param syncGroup 联动组名称
 * @returns Chart.js 插件实例
 */
export function createChartSyncPlugin(syncGroup: string): Plugin {
	let unsubscribe: (() => void) | null = null;
	let destroyed = false; // 销毁标志位，防止销毁中的图表响应更新

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
				// 如果图表已销毁，忽略所有状态更新
				if (destroyed) return;

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
			// 立即标记为已销毁，防止后续store更新触发操作
			destroyed = true;

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
	try {
		// 检查图表是否已销毁（ctx为null表示已销毁）
		if (!chart || !chart.ctx || !chart.tooltip) return;

		// 检查数据集
		if (!chart.data.datasets || chart.data.datasets.length === 0) return;

		// 构建 activeElements 数组，同时验证每个数据集的有效性
		const activeElements = [];
		for (let datasetIndex = 0; datasetIndex < chart.data.datasets.length; datasetIndex++) {
			const dataset = chart.data.datasets[datasetIndex];

			// 验证索引在数据范围内
			if (!dataset.data || index < 0 || index >= dataset.data.length) {
				continue;
			}

			// 验证对应的 controller 存在
			const meta = chart.getDatasetMeta(datasetIndex);
			if (!meta || !meta.controller || !meta.data || !meta.data[index]) {
				continue;
			}

			activeElements.push({ datasetIndex, index });
		}

		// 如果没有有效的元素，直接返回
		if (activeElements.length === 0) return;

		// 设置活动元素并更新 tooltip
		chart.tooltip.setActiveElements(activeElements, { x: 0, y: 0 });
		chart.update('none'); // 使用 'none' 模式避免动画
	} catch (error) {
		// 图表可能正在销毁，静默处理错误
		console.debug('Chart sync: tooltip update failed (chart may be destroying)', error);
	}
}

/**
 * 隐藏 tooltip
 */
function hideTooltip(chart: Chart) {
	try {
		// 检查图表是否已销毁
		if (!chart || !chart.ctx || !chart.tooltip) return;

		chart.tooltip.setActiveElements([], { x: 0, y: 0 });
		chart.update('none');
	} catch (error) {
		// 图表可能正在销毁，静默处理错误
		console.debug('Chart sync: tooltip hide failed (chart may be destroying)', error);
	}
}
