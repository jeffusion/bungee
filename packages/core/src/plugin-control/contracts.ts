/** Public contracts shared by a control-plane plugin and its host. */

import type { PluginConfigOptions } from '@jeffusion/bungee-types';
import type { PluginStorage } from '../plugin.types';
import type { PluginDurableState } from '../plugin-durable-state';
import type { ManagementProvider, ManagementSubject, PluginStateRpcContext, PluginPolicyPublication, DataPrincipal } from '../plugin-extensions';

export interface SecretValue {
  readonly version: number;
  readonly value: string;
}

export interface SecretStore {
  /** The host-injected namespace; plugins cannot select another namespace. */
  readonly namespace: string;
  get(key: string): Promise<SecretValue | null>;
  compareAndSet(key: string, expectedVersion: number | null, value: string): Promise<number>;
  delete(key: string, expectedVersion: number): Promise<void>;
}

export interface BoundControlClient {
  call<TResult = unknown>(method: string, payload: unknown, signal: AbortSignal): Promise<TResult>;
}

export interface CredentialLease {
  readonly version: number;
  readonly expiresAt: number;
  readonly headers: Readonly<Record<string, string>>;
}

export interface UpstreamAccount {
  readonly id: string;
  readonly label: string;
  readonly available: boolean;
  readonly reason?: string;
}

export type UpstreamAccountListItem = UpstreamAccount;

export interface UpstreamDraft {
  readonly target: string;
  readonly bindingOptions: PluginConfigOptions;
}

export interface CredentialPolicy {
  readonly allowedOrigins: readonly string[];
  readonly allowedRequests: readonly CredentialRequestPolicy[];
  readonly allowedHeaderNames: readonly string[];
}

export interface CredentialOutboundHeaderProfile {
  readonly passthrough: readonly string[];
  readonly set: Readonly<Record<string, string>>;
}

export interface CredentialRequestPolicy {
  readonly pathname: string;
  readonly methods: readonly string[];
  readonly outboundHeaders?: CredentialOutboundHeaderProfile;
}

/** Bounded, redacted diagnostic fields; never attach an upstream body or stack. */
export interface RawResponseError {
  readonly source: 'upstream' | 'transport';
  readonly message: string;
  readonly code?: string;
  readonly type?: string;
}

export type RawResponseCompletion =
  | { readonly status: 'completed' }
  | { readonly status: 'failed'; readonly code: string; readonly error?: RawResponseError }
  | { readonly status: 'incomplete'; readonly code: string }
  | { readonly status: 'cancelled' };

export interface RawResponseResult {
  readonly response: Response;
  readonly completion: Promise<RawResponseCompletion>;
}

export interface BoundAttemptContext {
  readonly attemptId: string;
  readonly clientStreaming: boolean;
  readonly signal: AbortSignal;
  readonly boundClient: BoundControlClient;
}

export interface ControlHostContext {
  readonly signal: AbortSignal;
  readonly managementOrigin?: string;
  readonly trustedSource?: (request: Request) => string;
  readonly secretStore: SecretStore;
  readonly storage: PluginStorage;
  readonly durableState?: PluginDurableState;
  readonly validateRouteReferences?: (routeIds: readonly string[]) => boolean | Promise<boolean>;
  readonly readResourceExtensions?: (keyId: string) => Promise<unknown>;
  readonly validateKeyPolicyReferences?: (keyId: string, policy: unknown) => boolean | Promise<boolean>;
  readonly publishPolicy?: (policy: PluginPolicyPublication) => Promise<void>;
}

export interface ControlApiHandlerContext extends ControlHostContext {
  readonly request: Request;
  readonly requestSignal: AbortSignal;
  readonly subject?: ManagementSubject;
}

export interface ControlBindingIdentity {
  readonly plugin: string;
  readonly contributionId: string;
  readonly bindingId: string;
  /** Host-resolved options from the bound endpoint; never sourced from RPC payload. */
  readonly bindingOptions: PluginConfigOptions;
}

export interface ControlRpcContext extends ControlHostContext {
  readonly attempt: BoundAttemptContext;
  readonly binding: ControlBindingIdentity;
}

export interface ControlApiDeclaration {
  readonly path: string;
  readonly methods: readonly string[];
  readonly handler: string;
  readonly invoke: (context: ControlApiHandlerContext) => Response | Promise<Response>;
}

export interface ControlRpcDeclaration {
  readonly name: string;
  readonly handler: string;
  readonly invoke: (payload: unknown, context: ControlRpcContext) => unknown | Promise<unknown>;
}

export interface PluginControl {
  readonly api: readonly ControlApiDeclaration[];
  readonly rpc: readonly ControlRpcDeclaration[];
  readonly management?: ManagementProvider;
  readonly stateRpc?: (method: string, payload: unknown, context: PluginStateRpcContext) => unknown | Promise<unknown>;
  readonly policy?: () => PluginPolicyPublication;
  start(): void | Promise<void>;
  dispose(): void | Promise<void>;
}

export type ControlApiTable = readonly ControlApiDeclaration[];
export type ControlRpcTable = readonly ControlRpcDeclaration[];

export interface OfflineRecoveryContext { readonly durableState: PluginDurableState }
export interface OfflineRecoveryCapability {
  readonly kind: 'identity' | 'plugin-state';
  recover(input: unknown, context: OfflineRecoveryContext): unknown | Promise<unknown>;
}

export interface ControlPlugin {
  readManagementSetup?(state: Pick<PluginDurableState, 'get' | 'list'>): {initialized:boolean};
  readonly offlineRecovery?: OfflineRecoveryCapability;
  createControl(context: ControlHostContext): PluginControl;
  /** Read persisted protections even while runtime/control is unavailable. */
  readAdmissionRequirements?(state: Pick<PluginDurableState, 'get' | 'list'>): readonly string[];
  verifyDataPrincipal?(principal: DataPrincipal, state: Pick<PluginDurableState, 'get' | 'list'>): boolean;
  readResourceCollection?(resource: string, state: Pick<PluginDurableState, 'get' | 'list'>): readonly unknown[] | Promise<readonly unknown[]>;
  /** Read a resource DTO without starting a disabled plugin or obtaining write capabilities. */
  readResource?(resource: string, id: string, state: Pick<PluginDurableState, 'get' | 'list'>):
    { value: unknown; usage?: unknown } | Promise<{ value: unknown; usage?: unknown }>;
}
