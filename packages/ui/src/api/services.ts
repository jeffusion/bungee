import { commitLogicalConfiguration, getConfigSnapshot } from './config';
import { toEditorService, toV2Service, type EditorService } from './config-adapters';

export type Service = EditorService;

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

  static async create(service: Service): Promise<void> {
    const snapshot = await getConfigSnapshot();
    const logical = snapshot.config.logical_configuration;
    if (logical.services.some((candidate) => candidate.name === service.name)) {
      throw new ServiceConflictError(service.name);
    }
    const position = logical.services.reduce((maximum, candidate) => Math.max(maximum, candidate.position), -1) + 1;
    await commitLogicalConfiguration(snapshot, {
      ...logical,
      services: [...logical.services, toV2Service(service, undefined, position)],
    });
  }

  static async update(originalName: string, updatedService: Service): Promise<void> {
    const snapshot = await getConfigSnapshot();
    const logical = snapshot.config.logical_configuration;
    const existing = logical.services.find((service) => service.name === originalName);
    if (existing === undefined) throw new ServiceNotFoundError(originalName);
    if (originalName !== updatedService.name
      && logical.services.some((service) => service.name === updatedService.name)) {
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
