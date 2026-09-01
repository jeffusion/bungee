import type {
  FailoverConfig,
  LoadBalancingConfig,
  PluginConfig,
  PluginConfigValue,
  RouteTimeoutsConfig,
} from '@jeffusion/bungee-types';
import { commitLogicalConfiguration, getConfigSnapshot, validateConfig } from './config';
import {
  toEditorRoute,
  toEditorService,
  toV2Route,
  type EditorRoute,
  type EditorService,
  type EditorUpstream,
} from './config-adapters';

export interface ModificationRules {
  add?: Record<string, unknown>;
  remove?: string[];
  replace?: Record<string, unknown>;
  default?: Record<string, unknown>;
}

export type Upstream = EditorUpstream;
export type Service = EditorService;
export type Route = EditorRoute;

export type {
  FailoverConfig,
  LoadBalancingConfig,
  PluginConfig,
  PluginConfigValue,
  RouteTimeoutsConfig,
};

export class RouteNotFoundError extends Error {
  readonly name = 'RouteNotFoundError';
  constructor(readonly path: string) { super(`Route with path "${path}" not found`); }
}

export class RouteConflictError extends Error {
  readonly name = 'RouteConflictError';
  constructor(readonly path: string) { super(`Route with path "${path}" already exists`); }
}

export function resolveRouteEndpoints(
  route: Partial<Pick<Route, 'endpoints' | 'service'>>,
  services: Service[] = [],
): Upstream[] {
  if (route.service) {
    return services.find((service) => service.name === route.service)?.endpoints ?? [];
  }
  return route.endpoints ?? [];
}

export class RoutesAPI {
  static async list(): Promise<Route[]> {
    const { logical_configuration: logical } = (await getConfigSnapshot()).config;
    return logical.routes.map((route) => toEditorRoute(route, logical.services));
  }

  static async get(path: string): Promise<Route | null> {
    return (await this.list()).find((route) => route.path === path) ?? null;
  }

  static async create(route: Route): Promise<void> {
    const snapshot = await getConfigSnapshot();
    const logical = snapshot.config.logical_configuration;
    if (logical.routes.some((candidate) => candidate.path === route.path)) throw new RouteConflictError(route.path);
    const position = logical.routes.reduce((maximum, candidate) => Math.max(maximum, candidate.position), -1) + 1;
    await commitLogicalConfiguration(snapshot, {
      ...logical,
      routes: [...logical.routes, toV2Route(route, logical, undefined, position)],
    });
  }

  static async update(originalPath: string, updatedRoute: Route): Promise<void> {
    const snapshot = await getConfigSnapshot();
    const logical = snapshot.config.logical_configuration;
    const existing = logical.routes.find((route) => route.path === originalPath);
    if (existing === undefined) throw new RouteNotFoundError(originalPath);
    if (originalPath !== updatedRoute.path && logical.routes.some((route) => route.path === updatedRoute.path)) {
      throw new RouteConflictError(updatedRoute.path);
    }
    const replacement = toV2Route(updatedRoute, logical, existing, existing.position);
    await commitLogicalConfiguration(snapshot, {
      ...logical,
      routes: logical.routes.map((route) => route.id === existing.id ? replacement : route),
    });
  }

  static async delete(path: string): Promise<void> {
    const snapshot = await getConfigSnapshot();
    const logical = snapshot.config.logical_configuration;
    const existing = logical.routes.find((route) => route.path === path);
    if (existing === undefined) throw new RouteNotFoundError(path);
    await commitLogicalConfiguration(snapshot, {
      ...logical,
      routes: logical.routes.filter((route) => route.id !== existing.id),
    });
  }

  static async validateRoute(route: Route): Promise<{ readonly valid: boolean; readonly error?: string }> {
    const snapshot = await getConfigSnapshot();
    const logical = snapshot.config.logical_configuration;
    const previous = logical.routes.find((candidate) => candidate.path === route.path);
    const converted = toV2Route(route, logical, previous, previous?.position ?? logical.routes.length);
    return await validateConfig(snapshot, { ...logical, routes: [converted] });
  }

  static async duplicate(path: string): Promise<void> {
    const route = await this.get(path);
    if (route === null) throw new RouteNotFoundError(path);
    const routes = await this.list();
    let suffix = 1;
    let newPath = `${path}-copy`;
    while (routes.some((candidate) => candidate.path === newPath)) {
      suffix += 1;
      newPath = `${path}-copy-${suffix}`;
    }
    await this.create({ ...route, path: newPath });
  }

  static async services(): Promise<Service[]> {
    const { logical_configuration: logical } = (await getConfigSnapshot()).config;
    return logical.services.map(toEditorService);
  }
}
