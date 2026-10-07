import { RATE_LIMIT_MAX_RPS, RATE_LIMIT_MAX_BURST, type RouteConfig } from '@jeffusion/bungee-types';
import { evaluateExpression, type ExpressionContext } from '../expression-engine';
import { normalizeRateLimitKey } from '../rate-limit';
import { getWorkerRateLimitClient, reportWorkerRateLimitFailure } from '../config-worker/rate-limit-provider';
import { WorkerRequestAdmission } from '../data-admission/worker';
import type { Plugin, PluginHooks } from '@jeffusion/bungee-core/plugin';
function resolveRateLimitKey(route: RouteConfig, trustedPeer: string | null, context: ExpressionContext) {
  const expression = route.rate_limit?.key_expression;
  if (expression !== undefined) {
    const match = /^\s*\{\{([\s\S]+)\}\}\s*$/.exec(expression);
    const source = match?.[1]?.trim();
    if (!source) throw new Error('rate-limit key expression is invalid');
    const evaluated = evaluateExpression(source, context);
    if (typeof evaluated !== 'string' && typeof evaluated !== 'number' && typeof evaluated !== 'boolean') {
      throw new Error('rate-limit key expression is invalid');
    }
    if (typeof evaluated === 'string') return normalizeRateLimitKey(evaluated);
    if (typeof evaluated === 'number') return normalizeRateLimitKey(evaluated);
    return normalizeRateLimitKey(evaluated);
  }
  if (trustedPeer === null) throw new Error('trusted client peer is unavailable');
  return normalizeRateLimitKey(trustedPeer, 'ip');
}

function rateLimitPolicy(route: RouteConfig): { readonly rps: number; readonly burst: number } {
  const rateLimit = route.rate_limit!;
  const rps = rateLimit.requests_per_second ?? 1;
  if (!Number.isFinite(rps) || rps <= 0 || rps > RATE_LIMIT_MAX_RPS) throw new Error('rate-limit rps is invalid');
  const burst = rateLimit.burst ?? Math.max(1, Math.ceil(rps));
  if (!Number.isSafeInteger(burst) || burst < 1 || burst > RATE_LIMIT_MAX_BURST) throw new Error('rate-limit burst is invalid');
  return { rps, burst };
}

type RateLimitCheck =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterMs?: number };

async function checkRateLimit(
  route: RouteConfig,
  trustedPeer: string | null,
  context: ExpressionContext,
  servingRevision: number | undefined,
  signal: AbortSignal,
): Promise<RateLimitCheck> {
  const rateLimit = route.rate_limit;
  if (!rateLimit?.enabled) {
    return { allowed: true };
  }
  const client = getWorkerRateLimitClient();
  if (client === null) {
    reportWorkerRateLimitFailure({ reason: 'unavailable', stage: 'precondition' });
    return { allowed: false };
  }
  if (route.id === undefined || servingRevision === undefined
    || !Number.isSafeInteger(servingRevision) || servingRevision < 1) {
    reportWorkerRateLimitFailure({ reason: 'configuration_invalid', stage: 'precondition' });
    return { allowed: false };
  }
  let key: ReturnType<typeof normalizeRateLimitKey>;
  let rps: number;
  let burst: number;
  try {
    const expression = rateLimit.key_expression === undefined ? '$client_ip' : rateLimit.key_expression;
    key = resolveRateLimitKey(route, trustedPeer, context);
    ({ rps, burst } = rateLimitPolicy(route));
  } catch {
    reportWorkerRateLimitFailure({ reason: 'configuration_invalid', stage: 'precondition' });
    return { allowed: false };
  }
  const expression = rateLimit.key_expression === undefined ? '$client_ip' : rateLimit.key_expression;
  try {
    const result = await client.debit({ routeId: route.id, keyExpression: expression, key, revision: servingRevision, rps, burst }, signal);
    return result.allowed ? { allowed: true } : { allowed: false, retryAfterMs: result.retry_after_ms };
  } catch {
    return { allowed: false };
  }
}


export class AdmissionPlugin implements Plugin {
  bodyRequirements() { return {request:'none' as const}; }
  register(hooks: PluginHooks): void {
    hooks.onGatewayAdmission.tapPromise('builtin.admission', input => checkRateLimit(input.route,input.trustedPeer,input.context,input.servingRevision,input.signal));
    hooks.onGatewayAdmissionSession.tap('builtin.admission', input => new WorkerRequestAdmission(input.handlers,input.identity,input.invoke));
    hooks.onGatewayAdmissionPrepare.tapPromise('builtin.admission', input => input.session.prepare(input.target,input.signal,input.readBody));
  }
}
