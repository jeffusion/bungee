import { api } from './client';
import type { AppConfig } from '../types';

export interface Route {
  path: string;
  pathRewrite?: { [pattern: string]: string };
  upstreams: Upstream[];
  headers?: ModificationRules;
  body?: ModificationRules;
  query?: ModificationRules;
  plugins?: string[];  // Changed from transformer
  auth?: { enabled: boolean; tokens: string[] };
  failover?: FailoverConfig;
  healthCheck?: HealthCheckConfig;
}

export interface Upstream {
  _uid?: string;  // Frontend-only field for list keys
  target: string;
  weight?: number;
  priority?: number;
  plugins?: string[];  // Changed from transformer
  headers?: ModificationRules;
  body?: ModificationRules;
  query?: ModificationRules;
  disabled?: boolean; // 是否禁用该上游，默认为 false（未禁用）
  description?: string; // 上游服务器的描述信息
  // Runtime state (from failover system)
  status?: 'HEALTHY' | 'UNHEALTHY';
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
  retryableStatusCodes?: number[];
  recoveryIntervalMs?: number;
  recoveryTimeoutMs?: number;
}

export interface HealthCheckConfig {
  enabled: boolean;
  interval?: number;
  timeout?: number;
  path?: string;
  healthyStatuses?: number[];
}

export class RoutesAPI {
  /**
   * 获取所有路由（包含运行时状态）
   */
  static async list(): Promise<Route[]> {
    return await api.get<Route[]>('/routes');
  }

  /**
   * 根据 path 获取单个路由
   */
  static async get(path: string): Promise<Route | null> {
    const routes = await this.list();
    return routes.find(r => r.path === path) || null;
  }

  /**
   * 创建新路由
   */
  static async create(route: Route): Promise<void> {
    const config = await api.get<AppConfig>('/config');

    // 检查路径是否已存在
    if (config.routes?.some((r: Route) => r.path === route.path)) {
      throw new Error(`Route with path "${route.path}" already exists`);
    }

    config.routes = config.routes || [];
    config.routes.push(route);

    await api.put('/config', config);
  }

  /**
   * 更新路由
   */
  static async update(originalPath: string, updatedRoute: Route): Promise<void> {
    const config = await api.get<AppConfig>('/config');

    const index = config.routes?.findIndex((r: Route) => r.path === originalPath);
    if (index === undefined || index === -1) {
      throw new Error(`Route with path "${originalPath}" not found`);
    }

    // 如果路径改变了，检查新路径是否已存在
    if (originalPath !== updatedRoute.path) {
      if (config.routes?.some((r: Route) => r.path === updatedRoute.path)) {
        throw new Error(`Route with path "${updatedRoute.path}" already exists`);
      }
    }

    config.routes![index] = updatedRoute;

    await api.put('/config', config);
  }

  /**
   * 删除路由
   */
  static async delete(path: string): Promise<void> {
    const config = await api.get<AppConfig>('/config');

    const index = config.routes?.findIndex((r: Route) => r.path === path);
    if (index === undefined || index === -1) {
      throw new Error(`Route with path "${path}" not found`);
    }

    config.routes!.splice(index, 1);

    await api.put('/config', config);
  }

  /**
   * 验证单个路由（通过临时配置验证）
   */
  static async validateRoute(route: Route): Promise<{ valid: boolean; error?: string }> {
    // 创建一个临时配置用于验证
    const tempConfig = {
      routes: [route]
    };

    return await api.post<{ valid: boolean; error?: string }>(
      '/config/validate',
      tempConfig
    );
  }

  /**
   * 复制路由
   */
  static async duplicate(path: string): Promise<void> {
    const route = await this.get(path);
    if (!route) {
      throw new Error(`Route with path "${path}" not found`);
    }

    // 创建副本，修改路径以避免冲突
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
