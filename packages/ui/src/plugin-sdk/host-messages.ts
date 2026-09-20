import type { Plugin } from '$api/plugins';

export type HostAction = 'ui-context' | 'copy-styles' | 'open-external' | 'new-service' | 'references' | 'control';

export type PluginHostRequest = Readonly<{
  type: 'bungee:host-request';
  generation: number;
  nonce: string;
  id: string;
  action: HostAction;
  path?: unknown;
  method?: unknown;
  body?: unknown;
  url?: unknown;
  accountRef?: unknown;
}>;

const HOST_ACTIONS = new Set<HostAction>(['ui-context', 'copy-styles', 'open-external', 'new-service', 'references', 'control']);
const MAX_BODY_BYTES = 65536;
export const MAX_SEEN_HOST_REQUEST_IDS = 1024;
const CONTROL_PATH = /^(?:\/(?:[A-Za-z0-9_~-]+|:[A-Za-z_$][A-Za-z0-9_$]*))+$/;

export type PluginHostPolicy = Readonly<{
  sandbox: 'allow-scripts';
  allowedHostActions: readonly HostAction[];
  controlAllowlist: readonly Readonly<{ path: string; methods: readonly ('GET' | 'POST' | 'PUT' | 'DELETE')[] }>[];
}>;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Validate the part of a request that is independent of the plugin manifest. */
export function validateHostRequest(
  value: unknown,
  generation: number,
  nonce: string,
  seenIds: Set<string>,
): { request: PluginHostRequest } | { error: string; id?: string } {
  const input = record(value);
  const id = typeof input?.id === 'string' ? input.id : undefined;
  if (input?.type !== 'bungee:host-request'
    || input.generation !== generation
    || input.nonce !== nonce) return { error: '桥接请求已失效', id };
  if (id === undefined || id.length === 0 || id.length > 128) return { error: '请求标识无效', id };
  if (seenIds.size >= MAX_SEEN_HOST_REQUEST_IDS) return { error: '请求数量超限', id };
  if (seenIds.has(id)) return { error: '请求已处理', id };
  if (!HOST_ACTIONS.has(input.action as HostAction)) return { error: '不支持的宿主操作', id };
  if (input.action === 'control') {
    let body: string;
    try {
      body = JSON.stringify(input.body ?? {});
    } catch {
      return { error: '请求内容无效', id };
    }
    if (typeof body !== 'string' || new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
      return { error: '请求内容过长', id };
    }
  }
  seenIds.add(id);
  return { request: input as unknown as PluginHostRequest };
}

/** Apply the backend policy and the manifest's frozen control declarations. */
export function allowedHostAction(
  policy: PluginHostPolicy,
  action: HostAction,
  path?: unknown,
  method?: unknown,
): boolean {
  return policy.allowedHostActions.includes(action)
    && (action !== 'control' || allowedControlRequest(policy, path, method));
}

export function isCanonicalControlPath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 4096 && CONTROL_PATH.test(value);
}

type BridgeResponse = Readonly<{
  type: 'bungee:host-result';
  generation: number;
  nonce: string;
  id: string;
  result?: unknown;
  error?: string;
}>;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  cleanup: () => void;
};

/** MessagePort-only client used by sandboxed plugin documents. */
export class PluginBridgeClient {
  private readonly pending = new Map<string, PendingRequest>();
  private disposed = false;

  constructor(
    readonly port: MessagePort,
    readonly generation: number,
    readonly nonce: string,
  ) {
    port.onmessage = (event: MessageEvent) => this.receive(event.data);
    port.start();
  }

  request<T>(action: HostAction, input: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('插件桥接已关闭'));
    const id = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      let removeAbortListener = () => {};
      const pending: PendingRequest = {
        resolve: resolve as (value: unknown) => void,
        reject,
        cleanup: () => removeAbortListener(),
      };
      this.pending.set(id, pending);
      const abort = () => {
        if (this.pending.delete(id)) {
          pending.cleanup();
          reject(new DOMException('The operation was aborted', 'AbortError'));
        }
      };
      if (signal?.aborted) return abort();
      if (signal) {
        removeAbortListener = () => signal.removeEventListener('abort', abort);
        signal.addEventListener('abort', abort, { once: true });
      }
      try {
        this.port.postMessage({ ...input, type: 'bungee:host-request', generation: this.generation, nonce: this.nonce, id, action });
      } catch (error) {
        this.pending.delete(id);
        pending.cleanup();
        reject(error);
      }
    });
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.port.onmessage = null;
    this.port.close();
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(new Error('插件桥接已关闭')); }
    this.pending.clear();
  }

  private receive(value: unknown): void {
    const message = record(value);
    if (message?.type === 'bungee:theme' && message.generation === this.generation && message.nonce === this.nonce
      && (message.theme === 'dark' || message.theme === 'light')) {
      document.documentElement.setAttribute('data-theme', message.theme);
      return;
    }
    const response = message as Partial<BridgeResponse> | null;
    if (response?.type !== 'bungee:host-result' || response.generation !== this.generation
      || response.nonce !== this.nonce || typeof response.id !== 'string') return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    pending.cleanup();
    if (typeof response.error === 'string') pending.reject(new Error(response.error));
    else pending.resolve(response.result);
  }
}

let activeBridge: PluginBridgeClient | undefined;
let resolveBridge: ((bridge: PluginBridgeClient) => void) | undefined;
const bridgeReady = typeof window === 'undefined'
  ? null
  : new Promise<PluginBridgeClient>(resolve => { resolveBridge = resolve; });

function receiveBridgeInit(event: MessageEvent): void {
  const input = record(event.data);
  const initGeneration = input?.generation;
  const initNonce = input?.nonce;
  if (event.source !== window.parent || input?.type !== 'bungee:bridge-init' || event.ports.length !== 1
    || typeof initGeneration !== 'number' || !Number.isSafeInteger(initGeneration) || initGeneration < 1
    || typeof initNonce !== 'string' || initNonce.length < 32) return;
  activeBridge?.close();
  activeBridge = new PluginBridgeClient(event.ports[0]!, initGeneration, initNonce);
  resolveBridge?.(activeBridge);
  resolveBridge = undefined;
}

if (typeof window !== 'undefined' && window.parent !== window) window.addEventListener('message', receiveBridgeInit);

export function requestPluginHostAction<T>(action: HostAction, input: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
  if (activeBridge) return activeBridge.request<T>(action, input, signal);
  if (bridgeReady === null) return Promise.reject(new Error('插件桥接不可用'));
  return bridgeReady.then(bridge => bridge.request<T>(action, input, signal));
}

export function allowedControlRequest(policy: PluginHostPolicy, path: unknown, method: unknown): path is string;
/** @deprecated Native, non-sandbox callers still use their manifest metadata. */
export function allowedControlRequest(plugin: Plugin, path: unknown, method: unknown): path is string;
export function allowedControlRequest(policyOrPlugin: PluginHostPolicy | Plugin, path: unknown, method: unknown): path is string {
  if (!('controlAllowlist' in policyOrPlugin)) {
    if (typeof path !== 'string' || path.length > 4096 || !/^\/[a-zA-Z0-9/_-]*(?:\?[^#\\]*)?$/.test(path) || path.includes('//')) return false;
    const pathname = path.split('?')[0];
    return !!policyOrPlugin.metadata?.contributes?.api?.some(api => api.execution === 'control' && api.path === pathname && api.methods.includes(method as never));
  }
  if (!isCanonicalControlPath(path)) return false;
  if (typeof method !== 'string' || !['GET', 'POST', 'PUT', 'DELETE'].includes(method)) return false;
  return policyOrPlugin.controlAllowlist.some(api => api.path === path && api.methods.includes(method as 'GET' | 'POST' | 'PUT' | 'DELETE'));
}

export function safeExternalUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
