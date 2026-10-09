import type { PluginDurableState, DurableJson } from './plugin-durable-state';

/** Anonymous is an explicit, signed data identity; it carries no key authority. */
export type DataPrincipal = { readonly domain: string; readonly keyId: string; readonly credentialVersion: number };
export const ANONYMOUS_PRINCIPAL: DataPrincipal = Object.freeze({domain: 'anonymous', keyId: '', credentialVersion: 0});
export interface AdmissionRequirement { readonly plugin: string; readonly routeIds: readonly string[] }
/** Public contracts. Business rules belong to the implementing plugin. */
export interface ManagementSubject {
  readonly id: string;
  readonly provider: string;
  readonly capabilities: readonly string[];
  readonly requiresPasswordChange?: boolean;
}
export interface ManagementProvider {
  authenticate(request: Request): Promise<ManagementSubject | null>;
  authorize(subject: ManagementSubject, capability: string): boolean;
  login(request: Request): Promise<Response>;
  logout(request: Request): Promise<Response>;
  bootstrap(input: unknown): Promise<void>;
  hasIdentity(): boolean;
  revokeSessions(): void;
  validateWrite?(request: Request): void;
  csrfToken?(request: Request): string | undefined;
  /** Optional browser cookie renewal after successful session verification. Must not extend the server-side absolute deadline. */
  sessionCookie?(request: Request): string | undefined;
}
export interface AdmissionTarget {
  /** Host-pinned entry scope for one internal handoff. */
  readonly entryRouteId?: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly principal: DataPrincipal;
  readonly routeId: string;
  readonly serviceId: string | null;
  readonly upstreamId: string;
  readonly url: string;
  readonly model: string | null;
  readonly now: number;
}
export interface AdmissionDenial {
  readonly error: string;
  readonly status: 401 | 403 | 429 | 503 | 422;
  readonly retryAfter?: number;
}
export interface AdmissionPlan {
  /** A complete JSON state replacement, staged by Host before the common decision. */
  readonly state?: DurableJson;
  /** Immutable policy snapshot retained by the grant for subsequent attempts. */
  readonly snapshot?: DurableJson;
  readonly denial?: AdmissionDenial;
}
export interface IngressPlugin {
  /** Effective policy demand; no policy means no content decoding. */
  bodyRequirements(target: AdmissionTarget, policy: DurableJson): { readonly request: 'none' | 'json-read' };
  /** Optional per-principal state. Policies are frozen; plans receive only this key's clones.
   * Expiry must mean absence is behaviorally equivalent to retaining the state. */
  keyedState?: {
    readonly capacity: number;
    policyForKey(policy: DurableJson, keyId: string): DurableJson;
    expiresAt(state: DurableJson): number;
    reconcile(state: DurableJson, policy: DurableJson, now: number): DurableJson;
  };
  authenticate?(request: Request, policy: DurableJson, now: number): DataPrincipal | null;
  resolveIdentity?(target: AdmissionTarget, policy: DurableJson): DataPrincipal;
  plan(target: AdmissionTarget, policy: DurableJson, state: DurableJson): AdmissionPlan;
  beforeAttempt?(target: AdmissionTarget, snapshot: DurableJson): AdmissionDenial | null;
}
export interface IngressPluginModule { createIngress(): IngressPlugin }
export interface PluginStateRpcContext {
  readonly state: PluginDurableState;
  readonly requestId: string;
  readonly attemptId: string;
  readonly principal: DataPrincipal;
}
export interface PluginPolicyPublication {
  readonly version: number;
  readonly value: DurableJson;
}
