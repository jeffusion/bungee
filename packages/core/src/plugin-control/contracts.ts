/** Public contracts shared by a control-plane plugin and its host. */

import type { PluginConfigOptions } from '@jeffusion/bungee-types';

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

export type RawResponseCompletion =
  | { readonly status: 'completed' }
  | { readonly status: 'failed'; readonly code: string }
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
  readonly secretStore: SecretStore;
}

export interface ControlApiHandlerContext extends ControlHostContext {
  readonly request: Request;
  readonly requestSignal: AbortSignal;
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
  start(): void | Promise<void>;
  dispose(): void | Promise<void>;
}

export type ControlApiTable = readonly ControlApiDeclaration[];
export type ControlRpcTable = readonly ControlRpcDeclaration[];

export interface ControlPlugin {
  createControl(context: ControlHostContext): PluginControl;
}
