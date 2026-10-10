import { createProtocolSession, describeProtocolConversion, ResponsesCodecError, type ProtocolSessionContext } from '@jeffusion/bungee-llms/plugin-api';
import type { ModelsDevCapabilitiesService } from '../../models-dev/contract';
import type { CapabilityContext, ConversionService, EffectiveCapabilities, AdapterSession } from '../contract';
export const REASONING_RULES_VERSION = '2026-10-10.3';
const concrete = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
/** Verified deployment alias; capability data still comes from the catalog model. */
function catalogModel(provider: string | undefined, model: string): string {
    return provider === 'zai' && model === 'GLM-5.3-Flash' ? 'glm-5.3-flash' : model;
}
/** Interface restrictions/defaults, not a second model capability catalog.
 * Sources: docs.z.ai/api-reference/llm/chat-completion and
 * platform.claude.com/docs/en/build-with-claude/effort (2026-10-10).
 */
function rule(provider: string, model: string, protocol: string) {
    if (provider === 'zai' && ['glm-5.3', 'glm-5.3-flash'].includes(model) && protocol === 'chat_completions')
        return { values: ['low', 'high', 'max'], default: 'max', kind: 'chat' as const };
    if (provider === 'anthropic' && protocol === 'anthropic_messages') {
        if (['claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'].includes(model))
            return { values: ['low', 'medium', 'high', 'xhigh', 'max'], default: ['claude-opus-5-5', 'claude-haiku-5-5'].includes(model) ? 'medium' : 'high', kind: 'anthropic' as const };
        if (['claude-opus-4-6', 'claude-sonnet-4-6'].includes(model))
            return { values: ['low', 'medium', 'high', 'max'], default: 'high', kind: 'anthropic' as const };
    }
    return null;
}
export function resolveCapabilities(catalog: ModelsDevCapabilitiesService, context: CapabilityContext): EffectiveCapabilities | null {
    context = { ...context, model: catalogModel(context.provider, context.model) };
    const info = catalog.model(context);
    if (!info)
        return null;
    const mapping = rule(context.provider, context.model, context.targetProtocol), restrictions = context.restrictions;
    const candidates = info.reasoningOptionsStatus === 'known' ? info.reasoningOptions?.flatMap(option => option.type === 'effort' ? option.values.filter((value): value is string => typeof value === 'string' && concrete.has(value)) : []) ?? [] : [];
    const selected = mapping && info.reasoning && restrictions?.reasoning !== false ? [...new Set(candidates)].filter(v => mapping.values.includes(v)) : [];
    // A selector also needs a documented default that actually belongs to its set.
    const supportedEfforts = mapping && selected.includes(mapping.default) ? selected : [];
    const defaultEffort = supportedEfforts.length ? mapping!.default : null;
    const wirePolicy = supportedEfforts.length ? { effortMap: Object.fromEntries(supportedEfforts.map(value => [value, value])), ...(mapping!.kind === 'anthropic' ? { anthropicThinkingMode: 'adaptive' as const } : {}) } : null;
    return { ...info, contextWindow: info.contextWindow === null ? null : Math.min(info.contextWindow, restrictions?.contextWindow ?? info.contextWindow),
        toolCall: info.toolCall && restrictions?.tools !== false, inputModalities: info.inputModalities.filter(v => v !== 'image' || restrictions?.images !== false),
        supportedEfforts, defaultEffort, rulesVersion: REASONING_RULES_VERSION, wirePolicy,
        codecCapabilities: { maxOutputTokens: info.outputLimit ?? undefined, reasoningHistory: info.reasoning && restrictions?.reasoning !== false,
            reasoningEffort: supportedEfforts.length > 0, anthropicEffort: mapping?.kind === 'anthropic' && supportedEfforts.length > 0,
            anthropicStructuredOutput: context.provider === 'anthropic' && /^claude-(?:opus-(?:4-[5678]|5(?:-5)?)|sonnet-(?:4-[56]|5(?:-5)?)|haiku-(?:4-5|5-5))$/.test(context.model),
            anthropicStrictTools: context.provider === 'anthropic' && /^claude-(?:opus-(?:4-[5678]|5(?:-5)?)|sonnet-(?:4-[56]|5(?:-5)?)|haiku-(?:4-5|5-5))$/.test(context.model), geminiJsonSchema: false } };
}
function fail(param: string): never { throw new ResponsesCodecError('unsupported_reasoning', 'Selected reasoning effort cannot be honored by the actual target', param); }
function wireEffort(body: any, protocol: string): unknown {
    return protocol === 'responses' ? body?.reasoning?.effort : protocol === 'chat_completions' ? body?.reasoning_effort : protocol === 'anthropic_messages' ? body?.output_config?.effort : body?.generationConfig?.thinkingConfig?.thinkingLevel;
}
export function conversionService(catalog: ModelsDevCapabilitiesService, worker: boolean): ConversionService {
    return {
        describe() { return { ...describeProtocolConversion(), rulesVersion: REASONING_RULES_VERSION }; },
        resolveCapabilities(context) { return resolveCapabilities(catalog, context); },
        createSession(context) {
            if (!worker)
                throw new Error('llm_adapter_conversion_requires_worker');
            const info = context.profile ?? catalog.model({ provider: context.provider, model: catalogModel(context.provider, context.model) });
            const profile = context.profile ? structuredClone(context.profile) : info ? resolveCapabilities(catalog, { provider: info.provider, model: context.model, targetProtocol: context.targetProtocol }) : undefined;
            let selected = context.selectedEffort;
            const passthrough = context.sourceProtocol === context.targetProtocol;
            if (!passthrough && selected !== undefined && (!profile || !profile.supportedEfforts.includes(selected)))
                fail('reasoning.effort');
            const engine = createProtocolSession({ ...context, capabilities: profile?.codecCapabilities ?? context.capabilities,
                reasoningPolicy: profile?.wirePolicy ?? context.reasoningPolicy } as ProtocolSessionContext);
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
                    if (!passthrough && selected !== undefined && context.targetProtocol === 'chat_completions' && profile?.provider === 'zai')
                        result.body.thinking = { type: 'enabled' };
                    return result;
                }, convertResponse: raw => engine.convertResponse(raw), push: event => engine.push(event), finish: () => engine.finish(),
                dispose() { if (!disposed) {
                    disposed = true;
                    engine.dispose();
                } },
                validateAttempt({ model, protocol, body, url }) {
                    if (disposed)
                        throw new Error('llm_adapter_session_disposed');
                    if (protocol !== context.targetProtocol)
                        throw new ResponsesCodecError('target_protocol_mismatch', 'Actual target protocol differs from the session', 'url');
                    if (url) {
                        const path = new URL(url).pathname;
                        const valid = protocol === 'responses' ? /\/responses$/.test(path) : protocol === 'chat_completions' ? /\/chat\/completions$/.test(path) : protocol === 'anthropic_messages' ? /\/messages$/.test(path) : /:(?:streamGenerateContent|generateContent)$/.test(path);
                        if (!valid)
                            throw new ResponsesCodecError('target_protocol_mismatch', 'Actual target URL does not implement the session protocol', 'url');
                    }
                    const actual = profile && profile.model === catalogModel(profile.provider, model) ? profile : profile ? resolveCapabilities(catalog, { provider: profile.provider, model, targetProtocol: protocol }) : null;
                    if (selected !== undefined) {
                        if (passthrough && model === context.model && wireEffort(body, protocol) === selected)
                            return { model, effort: selected, catalogVersion: profile?.catalogVersion ?? null, rulesVersion: REASONING_RULES_VERSION };
                        if (!actual || actual.catalogVersion !== profile?.catalogVersion || actual.rulesVersion !== profile?.rulesVersion || !actual.supportedEfforts.includes(selected) || wireEffort(body, protocol) !== selected)
                            fail('reasoning.effort');
                        if (protocol === 'anthropic_messages' && (body as any)?.thinking?.type !== 'adaptive')
                            fail('thinking.type');
                        if (protocol === 'chat_completions' && profile?.provider === 'zai' && (body as any)?.thinking?.type !== 'enabled')
                            fail('thinking.type');
                    }
                    return { model, effort: selected ?? null, catalogVersion: profile?.catalogVersion ?? null, rulesVersion: REASONING_RULES_VERSION };
                },
            };
            return session;
        },
    };
}
