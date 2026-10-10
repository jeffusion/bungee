import type { ModelsDevCapabilities } from '../models-dev/contract';
import type { LLMProtocol, ProtocolSession, ProtocolSessionContext, ProtocolReasoningPolicy, ProtocolSessionCapabilities } from '@jeffusion/bungee-llms/plugin-api';
export type { LLMProtocol, ProtocolSession, ProtocolRequestConversion, ProtocolSessionContext } from '@jeffusion/bungee-llms/plugin-api';
export const ADAPTER_PLUGIN = 'llm-protocol-adapter';
export const CONVERSION_SERVICE_ID = 'llm-protocol-adapter.conversion.v1';
export const CONVERSION_VERSION = 1;
export interface CapabilityContext {
    provider: string;
    model: string;
    targetProtocol: LLMProtocol;
    restrictions?: {
        tools?: boolean;
        images?: boolean;
        reasoning?: boolean;
        contextWindow?: number;
    };
}
export interface EffectiveCapabilities extends ModelsDevCapabilities {
    supportedEfforts: readonly string[];
    defaultEffort: string | null;
    rulesVersion: string;
    wirePolicy: ProtocolReasoningPolicy | null;
    codecCapabilities: ProtocolSessionCapabilities;
}
export interface AdapterSession extends ProtocolSession {
    validateAttempt(input: {
        model: string;
        protocol: LLMProtocol;
        body: unknown;
        url?: string;
    }): {
        model: string;
        effort: string | null;
        catalogVersion: number | null;
        rulesVersion: string;
    };
}
export interface ConversionService {
    describe(): {
        rulesVersion: string;
        protocols: readonly string[];
        matrix: readonly {
            sourceProtocol: string;
            targetProtocol: string;
            mode: string;
        }[];
    };
    resolveCapabilities(context: CapabilityContext): EffectiveCapabilities | null;
    createSession(context: ProtocolSessionContext & {
        profile?: EffectiveCapabilities;
        provider?: string;
        selectedEffort?: string;
    }): AdapterSession;
}
/** Escape surrogate units before bounded RPC slicing. */
function serializeHistory(value: unknown): string { return JSON.stringify(value).replace(/[\uD800-\uDFFF]/g, unit => '\\u' + unit.charCodeAt(0).toString(16).padStart(4, '0')); }
import { defineRpcService } from '@jeffusion/bungee-core/plugin';
const key = { type: 'string', minLength: 1, maxLength: 512 } as const;
/** Each canonical RPC frame is <=64 KiB; long histories use bounded ordered chunks. */
export const historyRpc = defineRpcService({ id: 'llm-protocol-adapter.history.v1', version: 1, methods: {
        get: { kind: 'query', input: { type: 'object', properties: { scope: key, id: key, index: { type: 'number', integer: true, minimum: 0, maximum: 1023 } } }, output: { type: 'json', maxBytes: 65536 }, purposes: ['background', 'request', 'attempt'] },
        put: { kind: 'command', input: { type: 'object', properties: { scope: key, id: key, index: { type: 'number', integer: true, minimum: 0, maximum: 1023 }, total: { type: 'number', integer: true, minimum: 1, maximum: 1024 }, data: { type: 'string', maxLength: 8192 } } }, output: { type: 'null' }, purposes: ['background', 'request', 'attempt'], command: { deduplication: 'none', resultRetentionMs: 1, quotaBytes: 1024, maxResultBytes: 1024 } },
    } });
export interface HistoryClient {
    get(input: {
        scope: string;
        id: string;
    }, options?: {
        signal?: AbortSignal;
    }): Promise<any>;
    put(input: {
        scope: string;
        id: string;
        value: any;
    }, options: {
        signal?: AbortSignal;
        operationId: string;
    }): Promise<unknown>;
}
export function historyClient(rpc: any): HistoryClient {
    return {
        async get({ scope, id }, options) {
            let text = '';
            for (let index = 0; index < 1024; index++) {
                options?.signal?.throwIfAborted();
                const part = await rpc.get({ scope, id, index }, options);
                if (part === null)
                    return null;
                text += part.data;
                if (Buffer.byteLength(text) > 8 * 1024 * 1024)
                    throw new Error('llm_adapter_history_limit');
                if (part.done)
                    return JSON.parse(text);
            }
            throw new Error('llm_adapter_history_limit');
        },
        async put({ scope, id, value }, options) {
            const text = serializeHistory(value), total = Math.ceil(text.length / 8192);
            if (total > 1024 || Buffer.byteLength(text) > 8 * 1024 * 1024)
                throw new Error('llm_adapter_history_limit');
            for (let index = 0; index < total; index++) {
                options.signal?.throwIfAborted();
                await rpc.put({ scope, id, index, total, data: text.slice(index * 8192, (index + 1) * 8192) }, { ...options, operationId: `${options.operationId}-${index}` });
            }
        },
    };
}
