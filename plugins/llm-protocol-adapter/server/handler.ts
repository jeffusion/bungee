import { logger, protocolSSEOutput, type Plugin, type PluginHooks, DataAdmissionError } from '@jeffusion/bungee-core/plugin';
import type { AdapterSession, LLMProtocol } from '../contract';
export function adapterError(error: unknown): never {
    const e = error as {
        code?: string;
        message?: string;
        param?: string;
    };
    if (typeof e?.code === 'string')
        throw new DataAdmissionError(422, `llm_adapter_${e.code}`, undefined, { message: e.message, param: e.param });
    throw error;
}
/** Transport hooks use only the shared BodyHandle; all codec state belongs to the service session. */
export function responseHandler(input: {
    session: AdapterSession;
    sourceProtocol: LLMProtocol;
    targetProtocol: LLMProtocol;
    signal?: AbortSignal;
    model: string;
    save?: (response: any, context: any) => Promise<void>;
    log?: (data: unknown) => void;
}): Plugin {
    let context: any, terminal: any, flushed = false;
    const dispose = () => input.session.dispose();
    input.signal?.addEventListener('abort', dispose, { once: true });
    const release = () => { input.signal?.removeEventListener('abort', dispose); dispose(); };
    const check = () => input.signal?.throwIfAborted();
    const remember = (events: any[]) => { for (const e of events)
        if (e.type === 'response.completed')
            terminal = e.response; };
    return { bodyRequirements() { return { request: 'none', response: ['json', 'sse-json'] }; }, register(hooks: PluginHooks) {
            hooks.onValidateOutbound.tapPromise('llm-adapter.target', async (outbound) => {
                check();
                try {
                    const result = input.session.validateAttempt({ model: outbound.model ?? input.model, protocol: input.targetProtocol, body: outbound.body, url: outbound.url });
                    logger.info({ requestId: outbound.requestId, attemptId: outbound.attemptId, ...result }, 'llm_adapter_target_validated');
                    input.log?.(result);
                }
                catch (e) {
                    adapterError(e);
                }
                return outbound;
            });
            hooks.onResponse.tapPromise('llm-adapter.response', async (response, ctx) => {
                context = ctx;
                if (!response.ok || !response.headers.get('content-type')?.includes('json'))
                    return response;
                check();
                const raw = await ctx.bodyHandle!.json({ id: 'llm-adapter.response', mandatory: true });
                let body: any;
                try {
                    body = structuredClone(input.session.convertResponse(raw));
                }
                catch (e) {
                    adapterError(e);
                }
                if (body.status === 'completed') {
                    check();
                    await input.save?.(body, ctx);
                }
                const headers = new Headers(response.headers);
                headers.delete('content-length');
                headers.delete('content-encoding');
                headers.set('content-type', 'application/json');
                release();
                return new Response(JSON.stringify(body), { status: response.status, headers });
            });
            hooks.onStreamChunk.tapPromise('llm-adapter.stream', async (envelope, ctx) => {
                context = ctx;
                check();
                if (envelope.data === '[DONE]')
                    return [];
                if (envelope.json === undefined)
                    return [envelope];
                let events: any[];
                try {
                    events = input.session.push(envelope.json);
                }
                catch (e) {
                    adapterError(e);
                }
                remember(events!);
                return protocolSSEOutput(events!, input.sourceProtocol, envelope);
            });
            hooks.onFlushStream.tapPromise('llm-adapter.finish', async (chunks) => {
                if (flushed)
                    return chunks;
                flushed = true;
                check();
                let events: any[];
                try {
                    events = input.session.finish();
                }
                catch (e) {
                    adapterError(e);
                }
                remember(events!);
                if (terminal) {
                    check();
                    await input.save?.(terminal, context);
                }
                release();
                return [...chunks, ...protocolSSEOutput(events!, input.sourceProtocol), ...(input.sourceProtocol === 'chat_completions' ? [{ data: '[DONE]' }] : [])];
            });
            hooks.onError.tap('llm-adapter.error', () => { terminal = undefined; release(); });
        } };
}
