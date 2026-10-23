import { v4 as uuidv4 } from 'uuid';
import type { ServiceReference } from '@jeffusion/bungee-types';

export function serviceReference(service_id: string, overrides: Partial<ServiceReference> = {}): ServiceReference {
  return { id: uuidv4(), position: 0, service_id, priority: 1, weight: 100, is_disabled: false, ...overrides };
}
