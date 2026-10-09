import { AsyncLocalStorage } from 'node:async_hooks';
import { createPluginHooks, type PluginHooks } from '../hooks';
import type { Plugin } from '../plugin.types';
import { getScopedPluginRegistry } from '../scoped-plugin-registry';
import { GATEWAY_PROVIDER_STAGES } from './contracts';
import { HttpRequestPlugin, type executeHttpRequest } from './request-plugin';
import { ForwardPlugin } from './forward-plugin';
import { DispatchPlugin } from './dispatch-plugin';
import { RoutingPlugin } from './routing-plugin';
import { AdmissionPlugin } from './admission-plugin';
import { SelectionPlugin } from './selection-plugin';
import { RetryPlugin } from './retry-plugin';
import { RequestRulesPlugin } from './request-rules-plugin';
import { ResponseRulesPlugin } from './response-plugin';
import { BodyServicePlugin } from './body-plugin';
import { LoggingPlugin } from './logging-plugin';

import { WebSocketGatewayPlugin } from './websocket-plugin';
import type { GatewayWebSocketInput, GatewayWebSocketResult } from './websocket-contracts';

const requestHooks = new AsyncLocalStorage<PluginHooks>();
let standaloneHooks: PluginHooks | undefined;
export function gatewayBuiltins(): Plugin[] {
  return [new WebSocketGatewayPlugin(),new BodyServicePlugin(),new HttpRequestPlugin(),new RoutingPlugin(),new DispatchPlugin(),new AdmissionPlugin(),new SelectionPlugin(),
    new RetryPlugin(),new RequestRulesPlugin(),new ForwardPlugin(),new ResponseRulesPlugin(),new LoggingPlugin()];
}
/** The host only owns registration; providers use the existing Plugin contract and Hook executor. */
export function registerGatewayBuiltins(hooks: PluginHooks, plugins: readonly Plugin[] = gatewayBuiltins()): void {
  for (const plugin of plugins) {
    if (typeof plugin.bodyRequirements !== 'function' || typeof plugin.register !== 'function')
      throw new Error('gateway provider does not implement the Plugin contract');
    plugin.register(hooks);
  }
}
export function validateGatewayProviders(hooks: PluginHooks): void {
  for (const stage of GATEWAY_PROVIDER_STAGES) {
    const count = hooks[stage].getStats().tapCount;
    if (count !== 1) throw new Error(`gateway stage ${stage} requires exactly one provider; received ${count}`);
  }
}
export function createGatewayHooks(plugins: readonly Plugin[] = gatewayBuiltins()): PluginHooks {
  const hooks = createPluginHooks();
  registerGatewayBuiltins(hooks,plugins);
  validateGatewayProviders(hooks);
  return hooks;
}
export function gatewayHooks(): PluginHooks {
  const captured = requestHooks.getStore();
  if (captured) return captured;
  const registry = getScopedPluginRegistry();
  if (registry && typeof registry.getGatewayHooks === 'function') return registry.getGatewayHooks();
  return standaloneHooks ??= createGatewayHooks();
}
export function initializeGateway(): void { gatewayHooks(); }
export function requireGatewayResult<T>(value: T | undefined, stage: string): T {
  if (value === undefined) throw new Error(`gateway provider ${stage} returned no result`);
  return value;
}
export const runGatewayRequest: typeof executeHttpRequest = async (...args) => {
  const hooks = gatewayHooks();
  return requestHooks.run(hooks, async () =>
    requireGatewayResult(await hooks.onGatewayRequest.promise(...args), 'onGatewayRequest'));
};

export async function runGatewayWebSocket(input: GatewayWebSocketInput): Promise<GatewayWebSocketResult> {
  const hooks = gatewayHooks();
  return requestHooks.run(hooks, async () => requireGatewayResult(
    await hooks.onGatewayWebSocket.promise(input), 'onGatewayWebSocket'));
}
