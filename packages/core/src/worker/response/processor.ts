/** Typed response Hook dispatch; processing belongs to the registered plugin. */
import { gatewayHooks, requireGatewayResult } from '../../gateway/runtime';
import type { executeResponseRules } from '../../gateway/response-plugin';
export { completionStream } from '../../gateway/response-plugin';
export type { PrepareResponseResult, StreamCompletionState } from '../../gateway/response-plugin';
export const prepareResponse: typeof executeResponseRules = async (...args) =>
  requireGatewayResult(await gatewayHooks().onGatewayResponseRules.promise(...args), 'onGatewayResponseRules');
