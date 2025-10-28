/**
 * Upstream selection module
 * Implements priority-based weighted random selection algorithm with slow start support
 */

import { forEach, sumBy, sortBy } from 'lodash-es';
import type { RuntimeUpstream, UpstreamSelector } from '../types';
import type { RouteConfig } from '@jeffusion/bungee-shared';
import { getEffectiveWeight } from '../utils/slow-start';

/**
 * Selects an upstream server based on priority and weight
 *
 * Selection algorithm:
 * 1. Group upstreams by priority (lower number = higher priority)
 * 2. Select the highest priority group
 * 3. Within that group, use weighted random selection
 * 4. Apply slow start weight adjustment if enabled
 *
 * @param upstreams - Available upstream servers
 * @param route - Route configuration (optional, for slow start)
 * @returns Selected upstream or undefined if none available
 *
 * @example
 * ```typescript
 * const upstreams = [
 *   { target: 'http://server1', priority: 1, weight: 100, status: 'HEALTHY' },
 *   { target: 'http://server2', priority: 1, weight: 50, status: 'HEALTHY' },
 *   { target: 'http://server3', priority: 2, weight: 100, status: 'HEALTHY' }
 * ];
 * const selected = selectUpstream(upstreams, route);
 * // Will select server1 or server2 (priority 1) with weight ratio adjusted by slow start
 * // server3 will only be selected if priority 1 group is exhausted
 * ```
 */
export function selectUpstream(
  upstreams: RuntimeUpstream[],
  route?: RouteConfig
): RuntimeUpstream | undefined {
  if (upstreams.length === 0) return undefined;

  // 按优先级分组 (priority 值越小优先级越高)
  const priorityGroups = new Map<number, RuntimeUpstream[]>();

  forEach(upstreams, (upstream) => {
    const priority = upstream.priority || 1;
    if (!priorityGroups.has(priority)) {
      priorityGroups.set(priority, []);
    }
    priorityGroups.get(priority)!.push(upstream);
  });

  // 获取排序后的优先级列表（从高到低）
  const sortedPriorities = sortBy(Array.from(priorityGroups.keys()));

  // 依次尝试每个优先级组，选择第一个有可用 upstream 的组
  for (const priority of sortedPriorities) {
    const priorityUpstreams = priorityGroups.get(priority)!;

    // 在同一优先级组内使用加权随机选择
    // 如果启用了慢启动，使用有效权重
    const totalWeight = sumBy(priorityUpstreams, (up) =>
      route ? getEffectiveWeight(up, route) : (up.weight ?? 100)
    );
    if (totalWeight === 0) continue;

    let random = Math.random() * totalWeight;
    for (const upstream of priorityUpstreams) {
      const weight = route ? getEffectiveWeight(upstream, route) : (upstream.weight ?? 100);
      random -= weight;
      if (random <= 0) {
        return upstream;
      }
    }

    // 如果由于浮点精度问题没有选中，返回组内最后一个
    if (priorityUpstreams.length > 0) {
      return priorityUpstreams[priorityUpstreams.length - 1];
    }
  }

  return undefined;
}

// Export legacy compatible version without route parameter
export const selectUpstreamLegacy: UpstreamSelector = (upstreams) => {
  return selectUpstream(upstreams);
};
