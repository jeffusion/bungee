import type { AppConfig, RouteConfig, CorsConfig, ResponseRuleConfig } from '@jeffusion/bungee-types';
import type { EffectiveRouteConfig } from '../worker/types';
import { resolveEffectiveRouteEndpoints, resolveRouteService } from '../utils/endpoint-resolver';
import type { Plugin, PluginHooks, GatewayRouteInput, GatewayRouteDecision } from '@jeffusion/bungee-core/plugin';
export function resolveEffectiveRoute(config: AppConfig, route: RouteConfig): EffectiveRouteConfig {
  const service = resolveRouteService(config, route);
  const endpoints = resolveEffectiveRouteEndpoints(route, config.services);

  return {
    ...route,
    endpoints,
    failover: service?.failover,
    load_balancing: service?.load_balancing,
    service_health_check: service?.health_check,
    state_key: service?.name ?? route.path,
  };
}

function stripRouteWildcard(routePath: string): string {
  return routePath.replace(/\/\*$/, '').replace(/\/:\w+/g, '');
}

function getRouteRelativePath(pathname: string, routePath: string): string {
  const basePath = stripRouteWildcard(routePath);
  if (!basePath || basePath === '/') return pathname;
  if (!pathname.startsWith(basePath)) return pathname;
  const relative = pathname.slice(basePath.length);
  return relative.startsWith('/') ? relative : `/${relative}`;
}

function pathMatchesRule(pathname: string, routePath: string, rule: ResponseRuleConfig): boolean {
  if (!rule.enabled || !rule.path) return false;

  const matchType = rule.match_type ?? 'exact';
  const normalizedRulePath = rule.path.startsWith('/') ? rule.path : `/${rule.path}`;
  const relativePath = getRouteRelativePath(pathname, routePath);
  const candidates = [pathname, relativePath];

  if (matchType === 'regex') {
    try {
      const pattern = new RegExp(normalizedRulePath);
      return candidates.some(candidate => pattern.test(candidate));
    } catch {
      return false;
    }
  }

  if (matchType === 'prefix') {
    return candidates.some(candidate => candidate.startsWith(normalizedRulePath));
  }

  return candidates.some(candidate => candidate === normalizedRulePath);
}

function findResponseRule(route: RouteConfig, pathname: string): ResponseRuleConfig | undefined {
  return route.response_rules?.find(rule => pathMatchesRule(pathname, route.path, rule));
}

function createResponseRuleResponse(rule: ResponseRuleConfig, req: Request): Response {
  if (rule.type === 'redirect') {
    const responseStatus = rule.status ?? 302;
    const redirectTarget = rule.url ?? '/';
    const redirectUrl = rule.preserve_path ? redirectTarget + new URL(req.url).pathname : redirectTarget;
    return new Response(null, { status: responseStatus, headers: { location: redirectUrl } });
  }

  const status = rule.status ?? 200;
  const headers = { ...(rule.headers ?? {}) };
  if (!Object.keys(headers).some(header => header.toLowerCase() === 'content-type')) {
    headers['content-type'] = rule.content_type ?? 'text/plain';
  }
  return new Response(rule.body ?? '', {
    status,
    headers
  });
}

function corsHeaders(cors: CorsConfig, request: Request): Record<string, string> {
  const origin = request.headers.get('origin') || '';
  const headers: Record<string, string> = {};
  if (cors.allowed_origins?.includes('*') || cors.allowed_origins?.includes(origin)) {
    headers['access-control-allow-origin'] = cors.allowed_origins?.includes('*') ? '*' : origin;
    if (cors.allow_credentials) headers['access-control-allow-credentials'] = 'true';
    if (cors.allowed_methods) headers['access-control-allow-methods'] = cors.allowed_methods.join(', ');
    if (cors.allowed_headers) headers['access-control-allow-headers'] = cors.allowed_headers.join(', ');
    if (cors.expose_headers) headers['access-control-expose-headers'] = cors.expose_headers.join(', ');
    if (cors.max_age !== undefined) headers['access-control-max-age'] = String(cors.max_age);
  }
  return headers;
}

export function applyCorsHeaders(response: Response, cors: CorsConfig | undefined, request: Request): Response {
  if (!cors?.enabled) {
    return response;
  }

  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(cors, request))) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}


export class RoutingPlugin implements Plugin {
  bodyRequirements() { return {request:'none' as const}; }
  register(hooks: PluginHooks): void {
    hooks.onGatewayCors.tap('builtin.routing',applyCorsHeaders);
    hooks.onGatewayRoute.tap('builtin.routing', ({request,config}: GatewayRouteInput): GatewayRouteDecision => {
      const url = new URL(request.url);
      const route = config.routes.find(candidate => url.pathname.startsWith(candidate.path));
      if (!route) return {};
      const effective = resolveEffectiveRoute(config, route);
      const rule = findResponseRule(route, url.pathname);
      if (rule) return {route,effective,response:createResponseRuleResponse(rule,request),responseKind:'rule'};
      if (route.direct_response?.enabled) {
        const {status,body,content_type,headers}=route.direct_response;
        return {route,effective,response:new Response(body ?? '',{status,headers:{'content-type':content_type ?? 'text/plain',...headers}})};
      }
      if (route.redirect?.enabled) {
        const {url:target,status,preserve_path}=route.redirect;
        return {route,effective,response:new Response(null,{status:status ?? 302,headers:{location:preserve_path ? target+url.pathname : target}})};
      }
      if (route.cors?.enabled && request.method.toUpperCase()==='OPTIONS')
        return {route,effective,response:new Response(null,{status:204,headers:corsHeaders(route.cors,request)})};
      return {route,effective};
    });
  }
}
