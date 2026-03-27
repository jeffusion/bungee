/**
 * Upstream selection module
 * Implements priority-based weighted random selection algorithm with slow start support
 */

import { forEach, sumBy, sortBy } from 'lodash-es';
import crypto from 'crypto';
import type { RuntimeUpstream, UpstreamSelector } from '../types';
import type { RouteConfig } from '@jeffusion/bungee-types';
import type { ExpressionContext } from '../../expression-engine';
import { processDynamicValue } from '../../expression-engine';
import { getEffectiveWeight } from '../utils/slow-start';
import { filterByCondition } from './condition-filter';

type RecordLike = Record<string, unknown>;

function isRecordLike(value: unknown): value is RecordLike {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getTrimmedString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return undefined;
}

function getDefaultStickySessionKey(context: ExpressionContext): string | undefined {
  const headerCandidates = [
    context.headers['x-session-id'],
    context.headers['x-conversation-id'],
    context.headers['x-thread-id']
  ];

  for (const candidate of headerCandidates) {
    const key = getTrimmedString(candidate);
    if (key) {
      return key;
    }
  }

  if (!isRecordLike(context.body)) {
    return undefined;
  }

  const bodyCandidates = [
    context.body.session_id,
    context.body.conversation_id,
    context.body.conversation,
    context.body.thread_id,
    context.body.response_id
  ];

  for (const candidate of bodyCandidates) {
    const key = getTrimmedString(candidate);
    if (key) {
      return key;
    }
  }

  return undefined;
}

function resolveStickySessionKey(route?: RouteConfig, context?: ExpressionContext): string | undefined {
  if (!route?.stickySession?.enabled || !context) {
    return undefined;
  }

  const expression = route.stickySession.keyExpression;
  if (typeof expression === 'string' && expression.trim().length > 0) {
    try {
      const evaluated = processDynamicValue(expression, context);
      const key = getTrimmedString(evaluated);
      if (key) {
        return key;
      }
    } catch {
      return undefined;
    }
  }

  return getDefaultStickySessionKey(context);
}

function hashToUnitInterval(input: string): number {
  const digest = crypto.createHash('sha256').update(input).digest();
  const uint32 = digest.readUInt32BE(0);
  return (uint32 + 1) / (0x100000000 + 1);
}

function selectStickyUpstream(
  upstreams: RuntimeUpstream[],
  stickyKey: string,
  route?: RouteConfig
): RuntimeUpstream | undefined {
  let selected: RuntimeUpstream | undefined;
  let selectedScore = Number.POSITIVE_INFINITY;

  for (const upstream of upstreams) {
    const weight = route ? getEffectiveWeight(upstream, route) : (upstream.weight ?? 100);
    if (weight <= 0) {
      continue;
    }

    const uniqueId = upstream.upstreamId || upstream.target;
    const random = hashToUnitInterval(`${stickyKey}::${uniqueId}`);
    const score = -Math.log(random) / weight;

    if (score < selectedScore) {
      selectedScore = score;
      selected = upstream;
    }
  }

  return selected;
}

/**
 * Selects an upstream server based on priority and weight
 *
 * Selection algorithm:
 * 1. Filter out disabled upstreams
 * 2. Filter by condition expression (if context provided)
 * 3. Group upstreams by priority (lower number = higher priority)
 * 4. Select the highest priority group
 * 5. Within that group, use weighted random selection
 * 6. Apply slow start weight adjustment if enabled
 *
 * @param upstreams - Available upstream servers
 * @param route - Route configuration (optional, for slow start)
 * @param context - Expression context for condition evaluation (optional)
 * @returns Selected upstream or undefined if none available
 *
 * @example
 * ```typescript
 * const upstreams = [
 *   { target: 'http://server1', priority: 1, weight: 100, status: 'HEALTHY' },
 *   { target: 'http://server2', priority: 1, weight: 50, status: 'HEALTHY', condition: "{{ body.model === 'gpt-4' }}" },
 *   { target: 'http://server3', priority: 2, weight: 100, status: 'HEALTHY' }
 * ];
 * const context = { body: { model: 'gpt-4' }, headers: {}, ... };
 * const selected = selectUpstream(upstreams, route, context);
 * // Will select server1 or server2 (priority 1) with weight ratio adjusted by slow start
 * // server3 will only be selected if priority 1 group is exhausted
 * ```
 */
export function selectUpstream(
  upstreams: RuntimeUpstream[],
  route?: RouteConfig,
  context?: ExpressionContext
): RuntimeUpstream | undefined {
  if (upstreams.length === 0) return undefined;

  // 过滤出未禁用的上游 (disabled !== true)
  let filteredUpstreams = upstreams.filter(u => !u.disabled);

  if (filteredUpstreams.length === 0) {
    // 所有上游都被禁用，返回 undefined
    return undefined;
  }

  // 按条件表达式过滤（如果提供了上下文）
  if (context) {
    filteredUpstreams = filterByCondition(filteredUpstreams, context);

    if (filteredUpstreams.length === 0) {
      // 所有上游条件都不匹配，返回 undefined
      return undefined;
    }
  }

  // 按优先级分组 (priority 值越小优先级越高)
  const priorityGroups = new Map<number, RuntimeUpstream[]>();
  const stickySessionKey = resolveStickySessionKey(route, context);

  forEach(filteredUpstreams, (upstream) => {
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

    if (stickySessionKey) {
      const stickySelected = selectStickyUpstream(priorityUpstreams, stickySessionKey, route);
      if (stickySelected) {
        return stickySelected;
      }
      continue;
    }

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
