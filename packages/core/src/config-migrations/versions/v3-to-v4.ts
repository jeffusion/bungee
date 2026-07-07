import type { Endpoint, FailoverConfig, RouteConfig, Service } from '@jeffusion/bungee-types';
import type { ConfigMigration, MigrationChange, MigrationWarning } from '../types';
import { cleanupEmptyObjects, cloneJson, isPlainRecord } from '../utils';

interface LegacyStickySessionConfig {
  enabled?: boolean;
  key_expression?: string;
}

interface LegacyRouteConfig extends RouteConfig {
  failover?: FailoverConfig;
  sticky_session?: LegacyStickySessionConfig;
}

function serviceNameFromPath(path: string): string {
  const base = path
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return `${base || 'root'}-service`;
}

function uniqueServiceName(preferredName: string, existingNames: Set<string>): string {
  if (!existingNames.has(preferredName)) {
    existingNames.add(preferredName);
    return preferredName;
  }

  let suffix = 2;
  while (existingNames.has(`${preferredName}-${suffix}`)) {
    suffix++;
  }

  const name = `${preferredName}-${suffix}`;
  existingNames.add(name);
  return name;
}

function moveRouteConfigToService(
  route: LegacyRouteConfig,
  service: Service,
  routeIndex: number,
  changes: MigrationChange[]
): void {
  if (route.failover && !service.failover) {
    service.failover = route.failover;
    changes.push({
      type: 'move',
      path: `routes.${routeIndex}.failover`,
      from: `routes.${routeIndex}.failover`,
      to: `services.${service.name}.failover`,
      message: `Moved route failover to service "${service.name}"`,
    });
  }

  if (route.sticky_session && !service.load_balancing) {
    const key_expression = route.sticky_session.key_expression;
    service.load_balancing = {
      policy: 'consistent_hash',
      ...(key_expression ? { hash_policy: { expression: key_expression } } : {}),
    };
    changes.push({
      type: 'move',
      path: `routes.${routeIndex}.sticky_session`,
      from: `routes.${routeIndex}.sticky_session`,
      to: `services.${service.name}.load_balancing`,
      message: `Migrated route sticky_session to service "${service.name}" as load_balancing.policy=consistent_hash`,
    });
  }

  if (route.failover) {
    delete route.failover;
  }
  if (route.sticky_session) {
    delete route.sticky_session;
  }
}

export const v3ToV4Migration: ConfigMigration = {
  fromVersion: 3,
  toVersion: 4,
  description: 'Move failover and migrate sticky_session to load_balancing.consistent_hash on services',
  migrate(input) {
    const config = cloneJson(input);
    if (!isPlainRecord(config)) {
      throw new Error('Config must be an object');
    }

    const changes: MigrationChange[] = [];
    const warnings: MigrationWarning[] = [];
    const routes = Array.isArray(config.routes) ? config.routes as LegacyRouteConfig[] : [];
    const services = Array.isArray(config.services) ? config.services as Service[] : [];
    const serviceNames = new Set(services.map(service => service.name));

    for (let routeIndex = 0; routeIndex < routes.length; routeIndex++) {
      const route = routes[routeIndex];
      if (!isPlainRecord(route)) {
        continue;
      }

      const hasRouteFailover = route.failover !== undefined;
      const hasRouteStickySession = route.sticky_session !== undefined;
      if (!hasRouteFailover && !hasRouteStickySession) {
        continue;
      }

      if (route.service) {
        let service = services.find(candidate => candidate.name === route.service);
        if (!service) {
          const routeEndpoints = route.endpoints ?? [];
          service = {
            name: route.service,
            endpoints: routeEndpoints,
          };
          services.push(service);
          serviceNames.add(service.name);
          changes.push({
            type: 'move',
            path: `routes.${routeIndex}.service`,
            to: `services.${service.name}`,
            message: `Created missing service "${service.name}" for route "${route.path}"`,
          });
        }

        moveRouteConfigToService(route, service, routeIndex, changes);
        continue;
      }

      const serviceName = uniqueServiceName(serviceNameFromPath(route.path), serviceNames);
      const routeEndpoints: Endpoint[] = route.endpoints ?? [];
      const service: Service = {
        name: serviceName,
        endpoints: routeEndpoints,
        ...(route.failover && { failover: route.failover }),
        ...(route.sticky_session && {
          load_balancing: {
            policy: 'consistent_hash' as const,
            ...(route.sticky_session.key_expression
              ? { hash_policy: { expression: route.sticky_session.key_expression } }
              : {}),
          },
        }),
      };
      services.push(service);
      route.service = serviceName;
      delete route.endpoints;

      changes.push({
        type: 'move',
        path: `routes.${routeIndex}`,
        from: `routes.${routeIndex}.endpoints/failover/sticky_session`,
        to: `services.${serviceName}`,
        message: `Created service "${serviceName}" from route "${route.path}" (sticky_session migrated to load_balancing)`,
      });

      moveRouteConfigToService(route, service, routeIndex, changes);
    }

    if (services.length > 0) {
      config.services = services;
    }
    config.config_version = 4;

    return {
      config: cleanupEmptyObjects(config),
      changes,
      warnings,
    };
  },
};
