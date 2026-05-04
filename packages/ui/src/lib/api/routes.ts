import { api } from './client';
import type { AppConfig, PluginConfigValue, RouteTimeoutsConfig } from '../types';

export interface PluginConfig {
  name: string;
  path?: string;
  options?: Record<string, PluginConfigValue>;
  enabled?: boolean;
}

export interface Route {
  path: string;
  pathRewrite?: { [pattern: string]: string };
  upstreams: Upstream[];
  headers?: ModificationRules;
  body?: ModificationRules;
  query?: ModificationRules;
  plugins?: Array<PluginConfig | string>;
  auth?: { enabled: boolean; tokens: string[] };
  timeouts?: RouteTimeoutsConfig;
  failover?: FailoverConfig;
  stickySession?: StickySessionConfig;
}

export interface StickySessionConfig {
  enabled: boolean;
  keyExpression?: string;
}

export interface Upstream {
  _uid?: string;
  target: string;
  weight?: number;
  priority?: number;
  plugins?: Array<PluginConfig | string>;
  headers?: ModificationRules;
  body?: ModificationRules;
  query?: ModificationRules;
  disabled?: boolean;
  description?: string;
  condition?: string;
  status?: 'HEALTHY' | 'UNHEALTHY' | 'HALF_OPEN';
  lastFailureTime?: number;
}

export interface ModificationRules {
  add?: Record<string, any>;
  remove?: string[];
  replace?: Record<string, any>;
  default?: Record<string, any>;
}

export interface FailoverConfig {
  enabled: boolean;
  retryOn?: number | string | (number | string)[];
  passiveHealth?: {
    consecutiveFailures?: number;
    healthySuccesses?: number;
    autoDisableThreshold?: number;
    autoEnableOnActiveHealthCheck?: boolean;
  };
  recovery?: {
    probeIntervalMs?: number;
    probeTimeoutMs?: number;
  };
  slowStart?: {
    enabled: boolean;
    durationMs?: number;
    initialWeightFactor?: number;
  };
  healthCheck?: {
    enabled: boolean;
    intervalMs?: number;
    timeoutMs?: number;
    path?: string;
    method?: string;
    expectedStatus?: number[];
    unhealthyThreshold?: number;
    healthyThreshold?: number;
    body?: string;
    contentType?: string;
    headers?: Record<string, string>;
    query?: Record<string, string>;
  };
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
      configVersion: 2,
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
