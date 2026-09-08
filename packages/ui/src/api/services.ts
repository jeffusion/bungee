import { commitLogicalConfiguration, getConfigSnapshot } from './config';
import { toEditorService, toV2Service, type EditorService } from './config-adapters';
import type { ServiceV2 } from '@jeffusion/bungee-types';
import { isEqual } from 'lodash-es';

export type Service = EditorService;
export type ServiceBaseline = ServiceV2;

export class ServiceStaleError extends Error {
  readonly name = 'ServiceStaleError';
  constructor(readonly serviceName: string, readonly reason: 'changed' | 'deleted') {
    super(reason === 'deleted'
      ? '该服务已被删除，未保存任何修改。当前草稿仍保留，请勿覆盖同名的新服务。'
      : '该服务已被其他操作修改，未保存任何修改。当前草稿仍保留，请重新加载最新版本后再编辑。');
  }
}

// Reuse the persistence adapter: editor descriptions and endpoint health are not configuration.
function persistedService(service: ServiceV2): ServiceV2 {
  return toV2Service(toEditorService(service), service, service.position);
}

export class ServiceReferencedError extends Error {
  readonly name = 'ServiceReferencedError';
  constructor(
    readonly serviceName: string,
    readonly routePaths: readonly string[],
  ) {
    super(`Service "${serviceName}" is referenced by routes`);
  }
}

export class ServiceNotFoundError extends Error {
  readonly name = 'ServiceNotFoundError';
  constructor(readonly serviceName: string) { super(`Service "${serviceName}" not found`); }
}

export class ServiceConflictError extends Error {
  readonly name = 'ServiceConflictError';
  constructor(readonly serviceName: string) { super(`Service with name "${serviceName}" already exists`); }
}

export class ServicesAPI {
  static async list(): Promise<Service[]> {
    const logical = (await getConfigSnapshot()).config.logical_configuration;
    return logical.services.map(toEditorService);
  }

  static async get(name: string): Promise<Service | null> {
    return (await this.list()).find((service) => service.name === name) ?? null;
  }

  static async getForEdit(name: string, id?: string): Promise<{ service: Service; baseline: ServiceBaseline } | null> {
    const logical = (await getConfigSnapshot()).config.logical_configuration;
    const existing = logical.services.find((service) => id === undefined ? service.name === name : service.id === id);
    if (existing === undefined) return null;
    return { service: toEditorService(existing), baseline: structuredClone(persistedService(existing)) };
  }

  static async create(service: Service): Promise<ServiceBaseline> {
    const snapshot = await getConfigSnapshot();
    const logical = snapshot.config.logical_configuration;
    if (logical.services.some((candidate) => candidate.name === service.name)) {
      throw new ServiceConflictError(service.name);
    }
    const position = logical.services.reduce((maximum, candidate) => Math.max(maximum, candidate.position), -1) + 1;
    const created = toV2Service(service, undefined, position);
    await commitLogicalConfiguration(snapshot, {
      ...logical,
      services: [...logical.services, created],
    });
    return created;
  }

  static async update(originalName: string, updatedService: Service, baseline: ServiceBaseline): Promise<ServiceBaseline> {
    const snapshot = await getConfigSnapshot();
    const logical = snapshot.config.logical_configuration;
    const existing = logical.services.find((service) => service.id === baseline.id);
    if (existing === undefined) throw new ServiceStaleError(originalName, 'deleted');
    if (!isEqual(persistedService(existing), persistedService(baseline))) {
      throw new ServiceStaleError(originalName, 'changed');
    }
    if (logical.services.some((service) => service.id !== existing.id && service.name === updatedService.name)) {
      throw new ServiceConflictError(updatedService.name);
    }
    const replacement = toV2Service(updatedService, existing, existing.position);
    await commitLogicalConfiguration(snapshot, {
      ...logical,
      services: logical.services.map((service) => service.id === existing.id ? replacement : service),
      routes: logical.routes.map((route) => route.service_id === existing.id
        ? { ...route, service_id: replacement.id }
        : route),
    });
    return replacement;
  }

  static async delete(name: string): Promise<void> {
    const snapshot = await getConfigSnapshot();
    const logical = snapshot.config.logical_configuration;
    const existing = logical.services.find((service) => service.name === name);
    if (existing === undefined) throw new ServiceNotFoundError(name);
    const referencingRoutes = logical.routes.filter((route) => route.service_id === existing.id);
    if (referencingRoutes.length > 0) {
      throw new ServiceReferencedError(name, referencingRoutes.map((route) => route.path));
    }
    await commitLogicalConfiguration(snapshot, {
      ...logical,
      services: logical.services.filter((service) => service.id !== existing.id),
    });
  }
}
