/** Compatibility entry point; forwarding has exactly one registered provider. */
import { gatewayHooks, requireGatewayResult } from '../../gateway/runtime';
import type { executeForward } from '../../gateway/forward-plugin';
export {
  AttemptCleanupError, UpstreamPhaseFailoverSignal, ManagedUpstreamAccessError,
  UpstreamTimeoutError, UpstreamNetworkError, isUpstreamTimeoutError,
  isUpstreamNetworkError, isManagedUpstreamAccessError, isUpstreamPhaseFailoverSignal,
} from '../../gateway/forward-plugin';
export type { ProxyRequestResult, ProxyAttemptOptions } from '../../gateway/forward-plugin';
export const proxyRequest: typeof executeForward = async (...args) =>
  requireGatewayResult(await gatewayHooks().onGatewayForward.promise(...args), 'onGatewayForward');
