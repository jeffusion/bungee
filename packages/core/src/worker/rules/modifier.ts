import { gatewayHooks, requireGatewayResult } from '../../gateway/runtime';
import type { executeBodyRules } from '../../gateway/request-rules-plugin';
export { deepMergeRules } from './deep-merge';
export const applyBodyRules: typeof executeBodyRules = async (...args) =>
  requireGatewayResult(await gatewayHooks().onGatewayBodyRules.promise(...args), 'onGatewayBodyRules');
