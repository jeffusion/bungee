import { api } from './client';
import type {
  AppConfig,
  Endpoint as BaseEndpoint,
  FailoverConfig,
  PluginConfig,
  PluginConfigValue,
  RouteConfig,
  RouteTimeoutsConfig,
  Service as BaseService,
  StickySessionConfig,
} from '@jeffusion/bungee-types';

export interface ModificationRules {
  add?: Record<string, any>;
  remove?: string[];
  replace?: Record<string, any>;
  default?: Record<string, any>;
}

export interface Upstream extends Omit<BaseEndpoint, 'headers' | 'body' | 'query'> {
  _uid?: string;
  headers?: ModificationRules;
  body?: ModificationRules;
  query?: ModificationRules;
  status?: 'HEALTHY' | 'UNHEALTHY' | 'HALF_OPEN';
  upstream_id?: string;
  last_failure_time?: number;
  consecutive_failures?: number;
  consecutive_successes?: number;
  recovery_attempt_count?: number;
  health_check_successes?: number;
  health_check_failures?: number;
}

export interface Service extends Omit<BaseService, 'endpoints'> {
  endpoints: Upstream[];
}

export interface Route extends Omit<RouteConfig, 'endpoints' | 'headers' | 'body' | 'query'> {
  headers?: ModificationRules;
  body?: ModificationRules;
  query?: ModificationRules;
  endpoints?: Upstream[];
  transformer?: string | object;
}

export type {
  AppConfig,
  FailoverConfig,
  PluginConfig,
  PluginConfigValue,
  RouteTimeoutsConfig,
  StickySessionConfig,
};

export function resolveRouteEndpoints(route: Partial<Pick<Route, 'endpoints' | 'service'>>, services: Service[] = []): Upstream[] {
  if (route.service) {
    const svc = services.find((service) => service.name === route.service);
    return svc?.endpoints ?? [];
  }

  return route.endpoints ?? [];
}

export class RoutesAPI {
  static async list(): Promise<Route[]> {
    return await api.get<Route[]>('/routes');
  }

  static async get(path: string): Promise<Route | null> {
    const routes = await this.list();
    return routes.find(r => r.path === path) || null;
  }

  static async create(route: Route): Promise<void> {
    const config = await api.get<AppConfig>('/config');

    if (config.routes?.some((r: Route) => r.path === route.path)) {
      throw new Error(`Route with path "${route.path}" already exists`);
    }

    config.routes = config.routes || [];
    config.routes.push(route);

    await api.put('/config', config);
  }

  static async update(originalPath: string, updatedRoute: Route): Promise<void> {
    const config = await api.get<AppConfig>('/config');

    const index = config.routes?.findIndex((r: Route) => r.path === originalPath);
    if (index === undefined || index === -1) {
      throw new Error(`Route with path "${originalPath}" not found`);
    }

    if (originalPath !== updatedRoute.path) {
      if (config.routes?.some((r: Route) => r.path === updatedRoute.path)) {
        throw new Error(`Route with path "${updatedRoute.path}" already exists`);
      }
    }

    config.routes![index] = updatedRoute;

    await api.put('/config', config);
  }

  static async delete(path: string): Promise<void> {
    const config = await api.get<AppConfig>('/config');

    const index = config.routes?.findIndex((r: Route) => r.path === path);
    if (index === undefined || index === -1) {
      throw new Error(`Route with path "${path}" not found`);
    }

    config.routes!.splice(index, 1);

    await api.put('/config', config);
  }

  static async validateRoute(route: Route): Promise<{ valid: boolean; error?: string }> {
    const tempConfig = {
      config_version: 4,
      routes: [route]
    };

    return await api.post<{ valid: boolean; error?: string }>(
      '/config/validate',
      tempConfig
    );
  }

  static async duplicate(path: string): Promise<void> {
    const route = await this.get(path);
    if (!route) {
      throw new Error(`Route with path "${path}" not found`);
    }

    const newRoute = { ...route };
    let suffix = 1;
    let newPath = `${path}-copy`;

    const routes = await this.list();
    while (routes.some((r: Route) => r.path === newPath)) {
      suffix++;
      newPath = `${path}-copy-${suffix}`;
    }

    newRoute.path = newPath;
    await this.create(newRoute);
  }
}
