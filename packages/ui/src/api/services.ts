import { api } from './client';
import type { AppConfig, Service as BaseService } from '@jeffusion/bungee-types';
import type { Upstream } from './routes';

export interface Service extends Omit<BaseService, 'endpoints'> {
  endpoints: Upstream[];
}

export class ServiceReferencedError extends Error {
  constructor(
    public readonly serviceName: string,
    public readonly routePaths: string[]
  ) {
    super(`Service "${serviceName}" is referenced by routes`);
    this.name = 'ServiceReferencedError';
  }
}

export class ServicesAPI {
  static async list(): Promise<Service[]> {
    const config = await api.get<AppConfig>('/config');
    return (config.services ?? []) as Service[];
  }

  static async get(name: string): Promise<Service | null> {
    const services = await this.list();
    return services.find(s => s.name === name) ?? null;
  }

  static async create(service: Service): Promise<void> {
    const config = await api.get<AppConfig>('/config');
    if (config.services?.some((s: Service) => s.name === service.name)) {
      throw new Error(`Service with name "${service.name}" already exists`);
    }
    config.services = config.services || [];
    config.services.push(service as any);
    await api.put('/config', config);
  }

  static async update(originalName: string, updatedService: Service): Promise<void> {
    const config = await api.get<AppConfig>('/config');
    const index = config.services?.findIndex((s: Service) => s.name === originalName);
    if (index === undefined || index === -1) {
      throw new Error(`Service "${originalName}" not found`);
    }
    if (originalName !== updatedService.name) {
      if (config.services?.some((s: Service) => s.name === updatedService.name)) {
        throw new Error(`Service with name "${updatedService.name}" already exists`);
      }
      // Also update route.service references
      config.routes?.forEach((r: any) => {
        if (r.service === originalName) {
          r.service = updatedService.name;
        }
      });
    }
    config.services![index] = updatedService as any;
    await api.put('/config', config);
  }

  static async delete(name: string): Promise<void> {
    const config = await api.get<AppConfig>('/config');
    const index = config.services?.findIndex((s: Service) => s.name === name);
    if (index === undefined || index === -1) {
      throw new Error(`Service "${name}" not found`);
    }
    // Check if any routes reference this service
    const referencingRoutes = config.routes?.filter(route => route.service === name) ?? [];
    if (referencingRoutes.length > 0) {
      throw new ServiceReferencedError(name, referencingRoutes.map(route => route.path));
    }
    config.services!.splice(index, 1);
    await api.put('/config', config);
  }
}
