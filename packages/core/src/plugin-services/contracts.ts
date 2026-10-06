/** Logical contracts are independent of the physical host address and generation. */
export type PluginServiceProcess = 'control' | 'worker' | 'ingress';
export type PluginServiceKind = 'local' | 'rpc' | 'events' | 'snapshot' | 'stream';
export type PluginServiceScope = 'global' | 'binding';

export interface PluginServicePublication {
  readonly id: string;
  readonly version: number;
  readonly process: PluginServiceProcess;
  readonly kind?: PluginServiceKind;
  readonly scope?: 'global';
}

export interface PluginServiceConsumption extends PluginServicePublication {
  readonly plugin: string;
}

export interface PluginServiceDeclarations {
  readonly provides?: readonly PluginServicePublication[];
  readonly consumes?: readonly PluginServiceConsumption[];
}

/** Unpublished extensions are rejected by every Host entry, including trusted embedders. */
export function assertSupportedServiceDeclarations(declarations: PluginServiceDeclarations): void {
  for (const service of [...declarations.provides ?? [], ...declarations.consumes ?? []]) {
    if (service.scope !== undefined && service.scope !== 'global') throw new Error('Only global service providers are supported');
    if (Object.hasOwn(service, 'optional')) throw new Error('Optional service declarations are not supported');
  }
}

/** Explicit self RPC/snapshot consumption from a different process, without a dependency edge. */
export function isCrossProcessSelfService(plugin: string, consumption: PluginServiceConsumption, declarations: PluginServiceDeclarations): boolean {
  return consumption.plugin === plugin && (consumption.kind === 'snapshot' || consumption.kind === 'rpc')
    && (consumption.scope ?? 'global') === 'global'
    && declarations.provides?.some(publication => publication.id === consumption.id
      && publication.version === consumption.version && publication.kind === consumption.kind
      && (publication.scope ?? 'global') === 'global' && publication.process !== consumption.process) === true
    && !declarations.provides?.some(publication => publication.id === consumption.id
      && publication.version === consumption.version && publication.kind === consumption.kind
      && publication.process === consumption.process);
}

export function isCrossProcessSelfSnapshot(plugin: string, consumption: PluginServiceConsumption, declarations: PluginServiceDeclarations): boolean {
  return consumption.kind === 'snapshot' && isCrossProcessSelfService(plugin, consumption, declarations);
}
