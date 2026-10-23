import type {
  AppConfig,
  Endpoint,
  PluginConfigOptions,
  RouteConfig,
  Service,
  ServiceReference,
} from './types.js';

export type ConfigurationId = string;

export type Sha256Digest = `sha256:${string}`;

export interface PluginActivation {
  readonly plugin_name: string;
}

export interface PluginBinding {
  readonly id: ConfigurationId;
  readonly position: number;
  readonly name: string;
  readonly options?: PluginConfigOptions;
  readonly enabled: boolean;
}

export interface UpstreamManagedBy {
  readonly plugin: string;
  readonly contributionId: string;
  readonly bindingId: ConfigurationId;
}

type ConfigurationUpstreamPolicy = Omit<
  Endpoint,
  'id' | 'position' | 'plugins' | 'weight' | 'priority' | 'is_disabled'
>;

export interface ConfigurationUpstream extends ConfigurationUpstreamPolicy {
  readonly id: ConfigurationId;
  readonly position: number;
  readonly weight: number;
  readonly priority: number;
  readonly is_disabled: boolean;
  readonly managedBy?: UpstreamManagedBy;
  readonly plugins: readonly PluginBinding[];
}

type ConfigurationServicePolicy = Omit<Service, 'name' | 'endpoints' | 'plugins' | 'service_references'>;

export interface ConfigurationService extends ConfigurationServicePolicy {
  readonly id: ConfigurationId;
  readonly position: number;
  readonly name: string;
  readonly endpoints: readonly ConfigurationUpstream[];
  readonly service_references?: readonly ServiceReference[];
  readonly plugins: readonly PluginBinding[];
}

type ConfigurationRoutePolicy = Omit<RouteConfig, 'path' | 'service_references' | 'endpoints' | 'plugins'>;

interface ConfigurationRouteBase extends ConfigurationRoutePolicy {
  readonly id: ConfigurationId;
  readonly position: number;
  readonly path: string;
  readonly plugins: readonly PluginBinding[];
}

export interface ConfigurationServiceRoute extends ConfigurationRouteBase {
  readonly service_references: readonly [ServiceReference, ...ServiceReference[]];
  readonly endpoints?: never;
}

export interface ConfigurationDirectRoute extends ConfigurationRouteBase {
  readonly service_references?: never;
  readonly endpoints: readonly ConfigurationUpstream[];
}

export type ConfigurationRoute = ConfigurationServiceRoute | ConfigurationDirectRoute;

type ConfigurationGlobalPolicy = Omit<AppConfig, 'config_version' | 'plugins' | 'services' | 'routes'>;

export interface LogicalConfiguration extends ConfigurationGlobalPolicy {
  readonly services: readonly ConfigurationService[];
  readonly routes: readonly ConfigurationRoute[];
  readonly plugins: readonly PluginBinding[];
}

export interface ConfigurationAggregate {
  readonly logical_configuration: LogicalConfiguration;
  readonly plugin_activations: readonly PluginActivation[];
}

export interface CommittedConfigurationSnapshot {
  readonly revision: number;
  readonly content_hash: Sha256Digest;
  readonly aggregate: ConfigurationAggregate;
}
