import type { EditorRoute, EditorService } from './config-adapters';

export function prefillRouteService(route: EditorRoute, services: readonly EditorService[], serviceId: string): EditorRoute {
  const service = services.find(item => item._uid === serviceId);
  if (!service) throw new Error('预选服务已不存在，请重新选择服务。');
  return { ...route, service: service.name, _serviceId: serviceId, endpoints: undefined };
}
