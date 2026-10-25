import { createProtocolSession, describeProtocolConversion, inspectAgentMessages, replaceAgentMessageEncryptedContent, ResponsesCodecError, protocolRequestModel, type ProtocolSessionContext } from '@jeffusion/bungee-llms/plugin-api';
import type { ModelIdentityDeclaration, ModelsDevCapabilitiesService } from '../../models-dev/contract';
import type { CapabilityContext, ConversionService, EffectiveCapabilities, AdapterSession, HistoryClient } from '../contract';
import {AgentRelay} from './relay';
export const REASONING_RULES_VERSION = '2026-10-24.1';
const concrete = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
// Protocol-level value constraints only. Responses/Chat carry the raw labelled effort;
// Gemini has no generic effort encoding, so it advertises no selector.
const effortProtocols = new Set(['responses', 'chat_completions', 'anthropic_messages']);
const anthropicEfforts = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
function identityError(code: string, message: string): never {
    throw new ResponsesCodecError(code, message, 'modelIdentity');
}
function parseModelIdentity(value: unknown): ModelIdentityDeclaration | undefined {
    if (value === undefined) return undefined;
    const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
    const identifier = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v === v.trim();
    if (!object(value) || Object.keys(value).length !== 2 || !Object.keys(value).every(key => ['wireModel', 'catalogModel'].includes(key)) || !identifier(value.wireModel)
        || !object(value.catalogModel) || Object.keys(value.catalogModel).length !== 2
        || !Object.keys(value.catalogModel).every(key => ['provider', 'model'].includes(key))
        || !identifier(value.catalogModel.provider) || !identifier(value.catalogModel.model))
        throw new ResponsesCodecError('invalid_model_identity', 'Model identity declaration is invalid', 'modelIdentity');
    return { wireModel: value.wireModel, catalogModel: { provider: value.catalogModel.provider, model: value.catalogModel.model } };
}
function checkedIdentity(value: unknown, model: string): ModelIdentityDeclaration | undefined {
    const identity = parseModelIdentity(value);
    if (identity && identity.wireModel !== model)
        identityError('model_identity_mismatch', 'Declared wire model differs from the actual target');
    return identity;
}
/** Presets are the concrete models.dev effort values; no provider/model allowlist exists. */
export function resolveCapabilities(catalog: ModelsDevCapabilitiesService, context: CapabilityContext): EffectiveCapabilities | null {
    const info = catalog.model(context);
    if (!info)
        return null;
    const restrictions = context.restrictions, reasoningAllowed = info.reasoning && restrictions?.reasoning !== false;
    const allowed = context.targetProtocol === 'anthropic_messages' ? anthropicEfforts : concrete;
    const candidates = reasoningAllowed && effortProtocols.has(context.targetProtocol) && info.reasoningOptionsStatus === 'known'
        ? info.reasoningOptions?.flatMap(option => option.type === 'effort' ? option.values.filter((value): value is Exclude<typeof value, null> => typeof value === 'string' && allowed.has(value)) : []) ?? []
        : [];
    const supportedEfforts = [...new Set(candidates)];
    // v1 publishes no verified default, so selection support never implies a default.
    const wirePolicy = supportedEfforts.length ? { effortMap: Object.fromEntries(supportedEfforts.map(value => [value, value])) } : null;
    return { ...info, contextWindow: info.contextWindow === null ? null : Math.min(info.contextWindow, restrictions?.contextWindow ?? info.contextWindow),
        toolCall: info.toolCall && restrictions?.tools !== false, inputModalities: info.inputModalities.filter(v => v !== 'image' || restrictions?.images !== false),
        supportedEfforts, defaultEffort: null, rulesVersion: REASONING_RULES_VERSION, wirePolicy,
        codecCapabilities: { maxOutputTokens: info.outputLimit ?? undefined, reasoningHistory: reasoningAllowed,
            reasoningEffort: supportedEfforts.length > 0, anthropicEffort: supportedEfforts.length > 0,
            anthropicStructuredOutput: context.provider === 'anthropic' && /^claude-(?:opus-(?:4-[5678]|5(?:-5)?)|sonnet-(?:4-[56]|5(?:-5)?)|haiku-(?:4-5|5-5))$/.test(context.model),
            anthropicStrictTools: context.provider === 'anthropic' && /^claude-(?:opus-(?:4-[5678]|5(?:-5)?)|sonnet-(?:4-[56]|5(?:-5)?)|haiku-(?:4-5|5-5))$/.test(context.model), geminiJsonSchema: false } };
}
function fail(param: string): never { throw new ResponsesCodecError('unsupported_reasoning', 'Selected reasoning effort cannot be honored by the actual target', param); }
function wireEffort(body: any, protocol: string): unknown {
    return protocol === 'responses' ? body?.reasoning?.effort : protocol === 'chat_completions' ? body?.reasoning_effort : protocol === 'anthropic_messages' ? body?.output_config?.effort : body?.generationConfig?.thinkingConfig?.thinkingLevel;
}
function chatMessages(body: unknown): Array<{ role?: unknown }> {
    const messages = body && typeof body === 'object' ? (body as { messages?: unknown }).messages : undefined;
    return Array.isArray(messages) ? messages as Array<{ role?: unknown }> : [];
}
export function conversionService(catalog: ModelsDevCapabilitiesService, worker: boolean, history?: HistoryClient, runBackground?: <T>(run:()=>T)=>T): ConversionService {
    const relay = new AgentRelay(history,Date.now,runBackground);
    return {
        inspectAgentMessages, replaceAgentMessageEncryptedContent,
        relayAgentMessage(input) {
            if (!worker) throw new Error('llm_adapter_conversion_requires_worker');
            const inspected=inspectAgentMessages({input:[input.message]});
            const message=inspected.messages[0];
            if (inspected.messages.length!==1 || message.encryptedContents.length!==1 || message.encryptedContents[0].contentIndex!==input.contentIndex)
                throw new ResponsesCodecError('unsupported_content','Relay requires exactly one encrypted agent content block',input.param);
            return relay.relay(input);
        },
        dispose() { relay.dispose(); },
        describe() { return { ...describeProtocolConversion(), rulesVersion: REASONING_RULES_VERSION }; },
        resolveCapabilities(context) { return resolveCapabilities(catalog, context); },
        createSession(context) {
            if (!worker)
                throw new Error('llm_adapter_conversion_requires_worker');
            const declaration = checkedIdentity(context.modelIdentity, context.model);
            const restrictions = context.restrictions ? structuredClone(context.restrictions) : undefined;
            const reference = declaration?.catalogModel ?? { provider: context.provider, model: context.model };
            const info = context.profile ?? catalog.model(reference);
            let profile = context.profile ? structuredClone(context.profile) : info ? resolveCapabilities(catalog, { provider: info.provider, model: info.model, targetProtocol: context.targetProtocol, restrictions }) : null;
            if (declaration && (!profile || profile.provider !== reference.provider || profile.model !== reference.model))
                identityError('model_identity_unavailable', 'Declared catalog model is unavailable');
            const entryProfile = profile;
            let catalogVersion = profile?.catalogVersion ?? null;
            let selected = context.selectedEffort, rewrittenDeveloper = false;
            const passthrough = context.sourceProtocol === context.targetProtocol;
            if (!passthrough && selected !== undefined && (!profile || !profile.supportedEfforts.includes(selected)))
                fail('reasoning.effort');
            const engine = createProtocolSession({ ...context, capabilities: profile?.codecCapabilities ?? context.capabilities,
                reasoningPolicy: profile?.wirePolicy ?? context.reasoningPolicy } as ProtocolSessionContext);
            // DeepSeek Chat rejects the Responses developer role; rewrite only the outbound body, not canonical history.
            const deepseekChat = context.sourceProtocol === 'responses' && context.targetProtocol === 'chat_completions' && profile?.provider === 'deepseek';
            let disposed = false;
            const session: AdapterSession = {
                convertRequest(raw) {
                    const effort = wireEffort(raw, context.sourceProtocol);
                    if (effort !== undefined) {
                        if (typeof effort !== 'string' || !passthrough && !profile?.supportedEfforts.includes(effort) || selected !== undefined && selected !== effort)
                            fail('reasoning.effort');
                        selected = effort;
                    }
                    const result = engine.convertRequest(raw);
                    rewrittenDeveloper = false;
                    if (deepseekChat)
                        for (const message of chatMessages(result.body))
                            if (message.role === 'developer') {
                                message.role = 'system';
                                rewrittenDeveloper = true;
                            }
                    return result;
                }, convertResponse: raw => engine.convertResponse(raw), push: event => engine.push(event), finish: () => engine.finish(),
                dispose() { if (!disposed) {
                    disposed = true;
                    engine.dispose();
                } },
                validateAttempt({ model, protocol, body, url, modelIdentity }) {
                    if (disposed) throw new Error('llm_adapter_session_disposed');
                    if (protocol !== context.targetProtocol)
                        throw new ResponsesCodecError('target_protocol_mismatch', 'Actual target protocol differs from the session', 'url');
                    if (url) {
                        let path: string;
                        try { path = new URL(url).pathname; }
                        catch { throw new ResponsesCodecError('target_protocol_mismatch', 'Actual target URL is invalid', 'url'); }
                        const valid = protocol === 'responses' ? /\/responses$/.test(path) : protocol === 'chat_completions' ? /\/chat\/completions$/.test(path) : protocol === 'anthropic_messages' ? /\/messages$/.test(path) : /:(?:streamGenerateContent|generateContent)$/.test(path);
                        if (!valid) throw new ResponsesCodecError('target_protocol_mismatch', 'Actual target URL does not implement the session protocol', 'url');
                    }
                    const actualModel = protocolRequestModel(protocol, body, url);
                    const identity = checkedIdentity(modelIdentity, actualModel);
                    if (model !== actualModel) identityError('model_identity_mismatch', 'Model argument differs from the actual target');
                    model = actualModel;
                    const reference = identity?.catalogModel ?? { provider: profile?.provider ?? context.provider, model };
                    const sameIdentity = !!profile && reference.provider === profile.provider && reference.model === profile.model;
                    const info = sameIdentity ? profile : catalog.model(reference);
                    const actual = sameIdentity ? profile : info ? resolveCapabilities(catalog, { provider: info.provider, model: info.model, targetProtocol: protocol, restrictions }) : null;
                    if (identity && !actual) identityError('model_identity_unavailable', 'Declared catalog model is unavailable');
                    if (actual && catalogVersion !== null && actual.catalogVersion !== catalogVersion)
                        identityError('model_identity_catalog_changed', 'Target catalog version differs from the generation snapshot');
                    if (rewrittenDeveloper && actual?.provider !== 'deepseek')
                        throw new ResponsesCodecError('unsupported_content', 'DeepSeek developer-role conversion cannot be sent to another target provider', 'messages');
                    if (context.sourceProtocol === 'responses' && protocol === 'chat_completions' && actual?.provider === 'deepseek' && chatMessages(body).some(message => message?.role === 'developer'))
                        throw new ResponsesCodecError('unsupported_content', 'DeepSeek target requires developer messages to be converted', 'messages');
                    const sameNativeIdentity = entryProfile
                        ? !!actual && actual.provider === entryProfile.provider && actual.model === entryProfile.model
                        : !identity && model === context.model;
                    if (selected !== undefined) {
                        if (!(passthrough && sameNativeIdentity && wireEffort(body, protocol) === selected)) {
                            if (!entryProfile || !actual || actual.rulesVersion !== entryProfile.rulesVersion || !actual.supportedEfforts.includes(selected) || wireEffort(body, protocol) !== selected)
                                fail('reasoning.effort');
                        }
                    } else if (!profile && actual && identity) {
                        // The first valid declaration can lock an otherwise unknown generation.
                        profile = structuredClone(actual);
                        catalogVersion = actual.catalogVersion;
                    }
                    return { model, catalogModel: actual ? { provider: actual.provider, model: actual.model } : null,
                        effort: selected ?? null, catalogVersion, rulesVersion: REASONING_RULES_VERSION };
                },
            };
            return session;
        },
    };
}
