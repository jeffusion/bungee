import type {
  AppConfig,
  Endpoint,
  PluginConfigOptions,
  RouteConfig,
  Service,
} from './types';

export type ConfigurationId = string;

export type Sha256Digest = `sha256:${string}`;

export interface PluginActivationV2 {
  readonly plugin_name: string;
}

export interface PluginBindingV2 {
  readonly id: ConfigurationId;
  readonly position: number;
  readonly name: string;
  readonly options?: PluginConfigOptions;
  readonly enabled: boolean;
}

export interface UpstreamManagedByV2 {
  readonly plugin: string;
  readonly contributionId: string;
  readonly bindingId: ConfigurationId;
}

type UpstreamPolicyV2 = Omit<
  Endpoint,
  'id' | 'plugins' | 'weight' | 'priority' | 'is_disabled'
>;

export interface UpstreamV2 extends UpstreamPolicyV2 {
  readonly id: ConfigurationId;
  readonly position: number;
  readonly weight: number;
  readonly priority: number;
  readonly is_disabled: boolean;
  readonly managedBy?: UpstreamManagedByV2;
  readonly plugins: readonly PluginBindingV2[];
}

type ServicePolicyV2 = Omit<Service, 'name' | 'endpoints' | 'plugins'>;

export interface ServiceV2 extends ServicePolicyV2 {
  readonly id: ConfigurationId;
  readonly position: number;
  readonly name: string;
  readonly endpoints: readonly UpstreamV2[];
  readonly plugins: readonly PluginBindingV2[];
}

type RoutePolicyV2 = Omit<RouteConfig, 'path' | 'service' | 'endpoints' | 'plugins'>;

interface RouteV2Base extends RoutePolicyV2 {
  readonly id: ConfigurationId;
  readonly position: number;
  readonly path: string;
  readonly plugins: readonly PluginBindingV2[];
}

export interface ServiceRouteV2 extends RouteV2Base {
  readonly service_id: ConfigurationId;
  readonly endpoints?: never;
}

export interface DirectRouteV2 extends RouteV2Base {
  readonly service_id?: never;
  readonly endpoints: readonly UpstreamV2[];
}

export type RouteV2 = ServiceRouteV2 | DirectRouteV2;

type GlobalPolicyV2 = Omit<AppConfig, 'config_version' | 'plugins' | 'services' | 'routes'>;

export interface LogicalConfigurationV2 extends GlobalPolicyV2 {
  readonly services: readonly ServiceV2[];
  readonly routes: readonly RouteV2[];
  readonly plugins: readonly PluginBindingV2[];
}

export interface ConfigurationAggregateV2 {
  readonly logical_configuration: LogicalConfigurationV2;
  readonly plugin_activations: readonly PluginActivationV2[];
}

export interface CommittedConfigurationSnapshotV2 {
  readonly revision: number;
  readonly content_hash: Sha256Digest;
  readonly aggregate: ConfigurationAggregateV2;
}
