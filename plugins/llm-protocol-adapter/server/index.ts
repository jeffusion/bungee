import { definePlugin, DataAdmissionError, logger, type Plugin, type PluginHooks, type PluginInitContext, type PluginConfigField } from '@jeffusion/bungee-core/plugin';
import { MODELS_DEV_CAPABILITIES_SERVICE_ID, MODELS_DEV_CAPABILITIES_CONTRACT_VERSION, type ModelsDevCapabilitiesService } from '../../models-dev/contract';
import { CONVERSION_SERVICE_ID, CONVERSION_VERSION, type LLMProtocol, type ConversionService, type AdapterSession } from '../contract';
import { conversionService } from './service';
import { responseHandler, adapterError } from './handler';
import manifest from '../manifest.json';
export function protocolForPath(path: string): LLMProtocol | null {
    if (/\/responses$/.test(path))
        return 'responses';
    if (/\/chat\/completions$/.test(path))
        return 'chat_completions';
    if (/\/messages$/.test(path))
        return 'anthropic_messages';
    if (/:(?:streamGenerateContent|generateContent)$/.test(path))
        return 'gemini_generate_content';
    return null;
}
export function targetPath(path: string, protocol: LLMProtocol, model: string, streaming: boolean): string {
    const suffix = protocol === 'responses' ? '/responses' : protocol === 'chat_completions' ? '/chat/completions' : protocol === 'anthropic_messages' ? '/messages' : `/models/${encodeURIComponent(model)}:${streaming ? 'streamGenerateContent' : 'generateContent'}`;
    return path.replace(/\/(?:responses|chat\/completions|messages|models\/[^/]+:(?:streamGenerateContent|generateContent))$/, suffix);
}
export default definePlugin(class implements Plugin {
    static readonly name = 'llm-protocol-adapter';
    static readonly version = '1.0.0';
    static readonly configSchema = manifest.configSchema as unknown as PluginConfigField[];
    private service!: ConversionService;
    private applied = false;
    private active = new Map<string, {
        handler: Plugin;
        session: AdapterSession;
    }>();
    constructor(private options?: {
        sourceProtocol: LLMProtocol;
        targetProtocol: LLMProtocol;
    }) { }
    async init(context: PluginInitContext) {
        const catalog = context.services!.consume<ModelsDevCapabilitiesService>('models-dev', MODELS_DEV_CAPABILITIES_SERVICE_ID, MODELS_DEV_CAPABILITIES_CONTRACT_VERSION);
        this.service = conversionService(catalog, true);
        if (context.scope?.type === 'global')
            context.services!.publish(CONVERSION_SERVICE_ID, CONVERSION_VERSION, this.service);
        this.applied = context.initializationKind !== 'automatic-provider';
        if (this.applied && !this.service.describe().matrix.some(p => p.sourceProtocol === this.options?.sourceProtocol && p.targetProtocol === this.options?.targetProtocol && p.mode !== 'unsupported'))
            throw new Error('llm_adapter_invalid_protocol_pair');
        context.services!.onDispose(() => { for (const value of this.active.values())
            value.session.dispose(); this.active.clear(); });
    }
    bodyRequirements(ctx: {
        method: string;
        url: URL;
    }) {
        return this.applied && ctx.method === 'POST' && protocolForPath(ctx.url.pathname) !== null ? { request: 'json-write' as const, response: ['json' as const, 'sse-json' as const] } : { request: 'none' as const };
    }
    register(hooks: PluginHooks) {
        if (!this.applied)
            return;
        hooks.onBeforeRequest.tap('llm-adapter.request', ctx => {
            if (ctx.method !== 'POST')
                return ctx;
            const source = protocolForPath(ctx.url.pathname);
            if (source === null) {
                if (/\/(?:models|messages\/count_tokens)$/.test(ctx.url.pathname))
                    throw new DataAdmissionError(422, 'llm_adapter_unsupported_endpoint');
                return ctx;
            }
            if (source !== this.options!.sourceProtocol)
                throw new DataAdmissionError(422, 'llm_adapter_source_protocol_mismatch');
            if (source === this.options!.targetProtocol)
                return ctx;
            if (this.active.has(ctx.requestId))
                throw new DataAdmissionError(422, 'llm_adapter_duplicate_conversion');
            const model = source === 'gemini_generate_content' ? decodeURIComponent(ctx.url.pathname.match(/\/models\/([^/]+):/)![1]) : ctx.body?.model;
            if (typeof model !== 'string' || !model)
                throw new DataAdmissionError(422, 'llm_adapter_model_required');
            const session = this.service.createSession({ sourceProtocol: source, targetProtocol: this.options!.targetProtocol, model, ...(source === 'gemini_generate_content' ? { streaming: ctx.url.pathname.endsWith(':streamGenerateContent') } : {}) });
            try {
                const result = session.convertRequest(ctx.body);
                if (result.diagnostics.length)
                    logger.info({ requestId: ctx.requestId, diagnostics: structuredClone(result.diagnostics) }, 'llm_adapter_request_diagnostics');
                ctx.body = structuredClone(result.body);
                ctx.url.pathname = targetPath(ctx.url.pathname, this.options!.targetProtocol, model, result.streaming);
                if (this.options!.targetProtocol === 'gemini_generate_content' && result.streaming)
                    ctx.url.searchParams.set('alt', 'sse');
            }
            catch (error) {
                session.dispose();
                adapterError(error);
            }
            const handler = responseHandler({ session, sourceProtocol: source, targetProtocol: this.options!.targetProtocol, model });
            this.active.set(ctx.requestId, { handler, session });
            return ctx;
        });
        // Register stable forwarding hooks once, per-request handlers contain no private readers.
        for (const name of ['onResponse', 'onStreamChunk', 'onFlushStream', 'onValidateOutbound', 'onError'] as const) {
            const target = hooks[name] as any;
            target.tapPromise(`llm-adapter.${name}`, async (...args: any[]) => {
                const ctx = name === 'onValidateOutbound' || name === 'onError' ? args[0] : args[1], value = this.active.get(ctx.requestId);
                if (!value)
                    return name === 'onResponse' || name === 'onFlushStream' ? args[0] : undefined;
                // A new facade contains hooks only, it never invokes another plugin's lifecycle.
                const local = (await import('@jeffusion/bungee-core/plugin')).createPluginHooks();
                value.handler.register(local);
                return (local[name] as any).promise(...args);
            });
        }
        hooks.onFinally.tap('llm-adapter.dispose', ctx => { this.active.get(ctx.requestId)?.session.dispose(); this.active.delete(ctx.requestId); });
    }
});
