/**
 * Upstream selection module
 * Strategy-pattern dispatcher with 4 pluggable algorithms:
 * weighted_random (default), round_robin, least_requests, consistent_hash.
 * Health-aware: filters UNHEALTHY and downweights HALF_OPEN.
 */

import { forEach, sortBy } from 'lodash-es';
import crypto from 'crypto';
import type { EffectiveRouteConfig, RuntimeCandidate, UpstreamSelector } from '../types';
import type { LoadBalancingConfig } from '@jeffusion/bungee-types';
import type { ExpressionContext } from '../../expression-engine';
import { processDynamicValue } from '../../expression-engine';
import { getEffectiveWeight } from '../utils/slow-start';
import { filterByCondition } from './condition-filter';
import { runtimeState, roundRobinCursors, getActiveRequestCount, tryAcquireHalfOpenSlot } from '../state/runtime-state';

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

function resolveHashKey(route: EffectiveRouteConfig, context: ExpressionContext): string | undefined {
  const lb = route.load_balancing;
  if (!lb?.hash_policy) return undefined;

  const hp = lb.hash_policy;
  if (hp.header) {
    const key = getTrimmedString(context.headers[hp.header.toLowerCase()]);
    if (key) return key;
  }
  if (hp.expression) {
    try {
      const evaluated = processDynamicValue(hp.expression, context);
      const key = getTrimmedString(evaluated);
      if (key) return key;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function hashToUnitInterval(input: string): number {
  const digest = crypto.createHash('sha256').update(input).digest();
  const uint32 = digest.readUInt32BE(0);
  return (uint32 + 1) / (0x100000000 + 1);
}

function effectiveWeight(upstream: RuntimeCandidate, route?: EffectiveRouteConfig): number {
  const base = route ? getEffectiveWeight(upstream, route) : (upstream.weight ?? 100);
  if (base <= 0) return 0;
  if (upstream.status === 'HALF_OPEN') return Math.max(1, Math.floor(base / 10));
  return base;
}

function healthFilter<T extends RuntimeCandidate>(upstreams: T[]): T[] {
  return upstreams.filter(u => u.status !== 'UNHEALTHY');
}

function halfOpenGate<T extends RuntimeCandidate>(stateKey: string, upstreams: T[]): T[] {
  return upstreams.filter(u => {
    if (u.status !== 'HALF_OPEN') return true;
    return tryAcquireHalfOpenSlot(stateKey, u.upstream_id);
  });
}

function selectWeightedRandom<T extends RuntimeCandidate>(upstreams: T[], route?: EffectiveRouteConfig): T | undefined {
  const totalWeight = upstreams.reduce((sum, u) => sum + effectiveWeight(u, route), 0);
  if (totalWeight === 0) return undefined;
  let random = Math.random() * totalWeight;
  for (const upstream of upstreams) {
    random -= effectiveWeight(upstream, route);
    if (random <= 0) return upstream;
  }
  return upstreams[upstreams.length - 1];
}



function selectRoundRobin<T extends RuntimeCandidate>(stateKey: string, upstreams: T[], _route?: EffectiveRouteConfig): T | undefined {
  const healthy = healthFilter(upstreams);
  if (healthy.length === 0) return undefined;
  const cursor = roundRobinCursors.get(stateKey) ?? 0;
  const idx = cursor % healthy.length;
  roundRobinCursors.set(stateKey, cursor + 1);
  return healthy[idx];
}

function selectLeastRequests<T extends RuntimeCandidate>(stateKey: string, upstreams: T[], route?: EffectiveRouteConfig): T | undefined {
  const healthy = healthFilter(upstreams);
  if (healthy.length === 0) return undefined;
  let best: T | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const u of healthy) {
    const active = getActiveRequestCount(stateKey, u.upstream_id);
    const w = effectiveWeight(u, route);
    if (w <= 0) continue;
    const score = active / w;
    if (score < bestScore) {
      bestScore = score;
      best = u;
    }
  }
  return best ?? healthy[0];
}

function selectConsistentHash<T extends RuntimeCandidate>(
  upstreams: T[],
  hashKey: string,
  route?: EffectiveRouteConfig
): T | undefined {
  let selected: T | undefined;
  let selectedScore = Number.POSITIVE_INFINITY;
  for (const upstream of upstreams) {
    const weight = effectiveWeight(upstream, route);
    if (weight <= 0) continue;
    const uniqueId = upstream.upstream_id || upstream.target;
    const random = hashToUnitInterval(`${hashKey}::${uniqueId}`);
    const score = -Math.log(random) / weight;
    if (score < selectedScore) {
      selectedScore = score;
      selected = upstream;
    }
  }
  return selected;
}

export function selectUpstream<T extends RuntimeCandidate>(
  upstreams: T[],
  route?: EffectiveRouteConfig,
  context?: ExpressionContext
): T | undefined {
  if (upstreams.length === 0) return undefined;

  let filteredUpstreams = upstreams.filter(u => !u.is_disabled);
  if (filteredUpstreams.length === 0) return undefined;

  if (context) {
    filteredUpstreams = filterByCondition(filteredUpstreams, context);
    if (filteredUpstreams.length === 0) return undefined;
  }

  const priorityGroups = new Map<number, T[]>();
  forEach(filteredUpstreams, (upstream) => {
    const priority = upstream.priority ?? 1;
    if (!priorityGroups.has(priority)) {
      priorityGroups.set(priority, []);
    }
    priorityGroups.get(priority)!.push(upstream);
  });

  const sortedPriorities = sortBy(Array.from(priorityGroups.keys()));
  const lb: LoadBalancingConfig | undefined =
    route?.load_balancing ?? (route ? runtimeState.get(route.state_key ?? route.path)?.load_balancing : undefined);
  const policy = lb?.policy ?? 'weighted_random';
  const stateKey = route?.state_key ?? route?.path ?? 'default';

  for (const priority of sortedPriorities) {
    const priorityUpstreams = priorityGroups.get(priority)!;
    const healthy = healthFilter(priorityUpstreams);
    if (healthy.length === 0) continue;
    const candidates = halfOpenGate(stateKey, healthy);
    if (candidates.length === 0) continue;

    let selected: T | undefined;

    switch (policy) {
      case 'round_robin':
        selected = selectRoundRobin(stateKey, candidates, route);
        break;
      case 'least_requests':
        selected = selectLeastRequests(stateKey, candidates, route);
        break;
      case 'consistent_hash': {
        const hashKey = context ? resolveHashKey(route!, context) : undefined;
        if (!hashKey) {
          selected = selectWeightedRandom(candidates, route);
        } else {
          selected = selectConsistentHash(candidates, hashKey, route);
        }
        break;
      }
      case 'weighted_random':
      default:
        selected = selectWeightedRandom(candidates, route);
        break;
    }

    if (selected) return selected;
  }

  return undefined;
}

export const selectUpstreamLegacy: UpstreamSelector = (upstreams) => {
  return selectUpstream(upstreams);
};
