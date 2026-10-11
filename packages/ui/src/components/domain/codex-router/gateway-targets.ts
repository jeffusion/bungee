import { getConfigSnapshot } from '$api/config';

export type CodexGatewayTarget = { type: 'route' | 'service'; id: string; label: string };

export async function loadCodexGatewayTargets(): Promise<CodexGatewayTarget[]> {
  const config = (await getConfigSnapshot()).config.logical_configuration;
  return [
    ...config.routes.map(route => ({ type: 'route' as const, id: route.id, label: route.path })),
    ...config.services.map(service => ({ type: 'service' as const, id: service.id, label: service.name })),
  ];
}
