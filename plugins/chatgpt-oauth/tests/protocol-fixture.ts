/** Keep wire fixtures in tests while the production protocol accepts central events only. */
export * from '../server/codex-protocol';
import * as protocol from '../server/codex-protocol';
import { sharedEvents, type FixtureSource } from './shared-body-fixture';
type Options = protocol.CodexConversionOptions & { maxBytes?: number };
export const parseCodexSSE = (source: FixtureSource, options: Options = {}) => protocol.parseCodexSSE(sharedEvents(source, options), options);
export const consumeCodexResponse = (source: FixtureSource, options: Options = {}) => protocol.consumeCodexResponse(sharedEvents(source, options), options);
export const convertCodexSSEToChatCompletion = (source: FixtureSource, options: Options = {}) => protocol.convertCodexSSEToChatCompletion(sharedEvents(source, options), options);
export const convertCodexSSEToChatCompletions = (source: FixtureSource, options: Options = {}) => protocol.convertCodexSSEToChatCompletions(sharedEvents(source, options), options);
export const convertCodexSSEToResponses = (source: FixtureSource, options: Options = {}) => protocol.convertCodexSSEToResponses(sharedEvents(source, options), options);
