import { logger, protocolSSEOutput, DataAdmissionError, type Plugin, type PluginHooks } from '@jeffusion/bungee-core/plugin';
import type { AdapterSession, LLMProtocol } from '../../llm-protocol-adapter/contract';
/** Codex transport integration only; all codec and state-machine methods are public service calls. */
export function protocolAdapter(input: {
    session: AdapterSession;
    protocol: LLMProtocol;
    model: string;
    save: (response: any, context: any) => Promise<void>;
    signal: AbortSignal;
}): Plugin {
    let nativeTerminal: any, sourceContext: any, flushed = false;
    const dispose = () => input.session.dispose();
    input.signal.addEventListener('abort', dispose, { once: true });
    const release = () => { input.signal.removeEventListener('abort', dispose); dispose(); };
    const convert = <T>(run: () => T): T => { try {
        return run();
    }
    catch (error) {
        const e = error as any;
        if (typeof e.code === 'string')
            throw new DataAdmissionError(422, `llm_adapter_${e.code}`, undefined, { message: e.message, param: e.param });
        throw error;
    } };
    const remember = (events: any[]) => { for (const event of events)
        if (event.type === 'response.completed')
            nativeTerminal = event.response; };
    return { bodyRequirements() { return { request: 'none', response: ['json', 'sse-json'] }; }, register(hooks: PluginHooks) {
            hooks.onValidateOutbound.tapPromise('codex-router.target', async (context) => { input.signal.throwIfAborted(); const result = convert(() => input.session.validateAttempt({ model: context.model ?? input.model, protocol: input.protocol, body: context.body, url: context.url })); logger.info({ requestId: context.requestId, attemptId: context.attemptId, ...result }, 'llm_adapter_target_validated'); return context; });
            hooks.onResponse.tapPromise('codex-router.protocol', async (response, context) => {
                if (!response.ok || !response.headers.get('content-type')?.includes('json'))
                    return response;
                const raw = await context.bodyHandle!.json({ id: 'codex-router.protocol', mandatory: true });
                const body: any = structuredClone(convert(() => input.session.convertResponse(raw)));
                body.model = input.model;
                if (body.status === 'completed') {
                    input.signal.throwIfAborted();
                    await input.save(body, context);
                }
                release();
                const headers = new Headers(response.headers);
                headers.delete('content-length');
                headers.delete('content-encoding');
                headers.set('content-type', 'application/json');
                return new Response(JSON.stringify(body), { status: response.status, headers });
            });
            hooks.onStreamChunk.tapPromise('codex-router.protocol', async (envelope, context) => {
                sourceContext = context;
                input.signal.throwIfAborted();
                if (envelope.data === '[DONE]')
                    return [];
                if (envelope.json === undefined)
                    return [envelope];
                const events = structuredClone(convert(() => input.session.push(envelope.json)));
                remember(events);
                return protocolSSEOutput(events.map(e => e.response ? { ...e, response: { ...e.response as any, model: input.model } } : e), 'responses', envelope);
            });
            hooks.onFlushStream.tapPromise('codex-router.protocol', async (chunks) => {
                if (flushed)
                    return chunks;
                flushed = true;
                input.signal.throwIfAborted();
                const events = structuredClone(convert(() => input.session.finish()));
                remember(events);
                if (nativeTerminal) {
                    input.signal.throwIfAborted();
                    await input.save(nativeTerminal, sourceContext);
                }
                release();
                return [...chunks, ...protocolSSEOutput(events, 'responses')];
            });
            hooks.onError.tap('codex-router.protocol-error', () => { nativeTerminal = undefined; release(); });
        } };
}
