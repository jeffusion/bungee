/** HTTP host boundary: business execution is supplied through Plugin.register. */
import { runGatewayRequest } from '../../gateway/runtime';
import type { executeHttpRequest } from '../../gateway/request-plugin';
export type { HandleRequestRuntimeContext } from '../../gateway/request-plugin';
export const handleRequest: typeof executeHttpRequest = runGatewayRequest;
