import type { GatewayBodyArguments } from './contracts';
import type { BodySource } from './body-service';
import { gatewayHooks, requireGatewayResult } from './runtime';

/** Uses the request's captured registry; no separate container or async initialization. */
export function createBodySource(...args: GatewayBodyArguments): BodySource {
  return requireGatewayResult(gatewayHooks().onGatewayBody.call(...args), 'onGatewayBody');
}
