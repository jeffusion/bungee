import type { Endpoint } from '@jeffusion/bungee-types';

/**
 * Join base path and relative path with slash normalization.
 * Rules:
 * - No double slashes in result
 * - Single slash between segments
 * - Empty segments handled gracefully
 */
export function joinPaths(base: string, relative: string): string {
  if (!base && !relative) return '/';
  if (!base) return normalizeSlashes(relative) || '/';
  if (!relative) return normalizeSlashes(base) || '/';

  const baseNorm = normalizeSlashes(base).replace(/\/+$/, '');
  const relNorm = normalizeSlashes(relative).replace(/^\/+/, '');

  if (!baseNorm) return '/' + relNorm;
  if (!relNorm) return baseNorm;
  return `${baseNorm}/${relNorm}`;
}

function normalizeSlashes(path: string): string {
  return path.replace(/\/+/g, '/');
}

/**
 * Mutable request context interface (what the pipeline passes around).
 * This matches the actual context shape used in handler.ts.
 */
export interface MutableRequestContext {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: any;
  query?: Record<string, string>;
  upstreamId?: string;
  routeId?: string;
  serviceName?: string;
  [key: string]: any;
}

/**
 * Deep clone a mutable request context for failover attempts.
 * Each failover attempt starts from the same base state.
 * Mutations on the clone do NOT affect the original.
 */
export function cloneMutableRequestContext(ctx: MutableRequestContext): MutableRequestContext {
  return {
    ...ctx,
    url: new URL(ctx.url.toString()),
    headers: { ...ctx.headers },
    body: ctx.body !== undefined ? structuredClone(ctx.body) : undefined,
    query: ctx.query ? { ...ctx.query } : undefined,
  };
}

/**
 * Rebase a route-relative context to a specific upstream target.
 * Called after Phase 1+2 (route and service plugins) have modified the context,
 * before Phase 3 (upstream/endpoint plugins) executes.
 *
 * Algorithm:
 * 1. Parse upstream.target as URL
 * 2. Set ctx.url.protocol/host/port from target
 * 3. Join paths: joinPaths(targetUrl.pathname, ctx.url.pathname)
 * 4. Preserve query string from Phase 1+2
 * 5. Set upstreamId
 */
export function rebaseToUpstream(
  ctx: MutableRequestContext,
  upstream: Endpoint
): void {
  const targetUrl = new URL(upstream.target);

  ctx.url.protocol = targetUrl.protocol;
  ctx.url.hostname = targetUrl.hostname;
  ctx.url.port = targetUrl.port;

  const joinedPath = joinPaths(targetUrl.pathname, ctx.url.pathname);
  ctx.url.pathname = joinedPath;

  ctx.upstreamId = upstream.id || upstream.target;
}

/**
 * Build context for request-level onFinally hooks.
 * These execute once per request: global -> route -> service (in that order).
 */
export function buildRequestLevelFinallyContext(
  routeId: string,
  serviceName?: string
): Record<string, any> {
  return {
    phase: 'request-level',
    routeId,
    ...(serviceName && { serviceName }),
  };
}

/**
 * Build context for final-upstream-level onFinally hooks.
 * These execute for the final upstream only (the one that actually responded).
 */
export function buildFinalUpstreamFinallyContext(
  routeId: string,
  upstreamId: string,
  serviceName?: string
): Record<string, any> {
  return {
    phase: 'final-upstream-level',
    routeId,
    upstreamId,
    ...(serviceName && { serviceName }),
  };
}
