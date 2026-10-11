import { DataAdmissionError, type GatewayAuxiliaryResult } from '@jeffusion/bungee-core/plugin';

export const RELAY_TOOL = 'relay_external_agent_payload';
function invalid(param: string): never { throw new DataAdmissionError(502, 'llm_adapter_relay_invalid_response', undefined, {param, message: 'Relay response did not contain a complete payload'}); }
function payload(response: any, param: string): string {
    if (response?.status !== 'completed' || response.error || response.incomplete_details || !Array.isArray(response.output) || response.output.length > 128 || response.output.some((item:any)=>!['reasoning','function_call'].includes(item?.type))) invalid(param);
    const calls=response.output.filter((item:any)=>item.type==='function_call');
    if(calls.length!==1)invalid(param);
    const call = calls[0];
    if (call?.type !== 'function_call' || call.name !== RELAY_TOOL || call.status !== 'completed' || typeof call.arguments !== 'string') invalid(param);
    let args: any; try { args = JSON.parse(call.arguments); } catch { invalid(param); }
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 1 || typeof args.payload !== 'string') invalid(param);
    return args.payload;
}
/** Wire framing and decoding are exclusively supplied by the host BodyHandle. */
export async function relayPayload(result: GatewayAuxiliaryResult, param: string, signal: AbortSignal): Promise<string> {
    if (result.kind === 'reused') { if (typeof result.value !== 'string') invalid(param); return result.value; }
    try {
        if (result.status < 200 || result.status >= 300) throw new DataAdmissionError(result.status === 401 || result.status === 429 ? result.status : 502, 'llm_adapter_relay_upstream_failed', undefined, {param, message: `Relay upstream rejected the request (HTTP ${result.status})`});
        let response: any;
        if (result.bodyHandle.identity.contentType.includes('text/event-stream') || result.bodyHandle.identity.contentType.includes('application/octet-stream')) {
            const iterator = result.bodyHandle.events({id:'llm-adapter.relay', mandatory:true, signal})[Symbol.asyncIterator]();
            let call: any, callIndex:number|undefined, args = '', argumentBytes=0, argumentsDone: string | undefined, outputDone = false, terminal = false, done = false;
            const reasoning=new Map<number,{id:string;done:boolean}>();let reasoningBytes=0;
            const reasoningEvents=new Set(['response.reasoning_summary_part.added','response.reasoning_summary_part.done','response.reasoning_summary_text.delta','response.reasoning_summary_text.done','response.reasoning_text.delta','response.reasoning_text.done']);
            try {
                for (;;) {
                    signal.throwIfAborted(); const next = await iterator.next(); if (next.done) break;
                    const frame = next.value; if (frame.truncated) invalid(param); if (frame.hasData === false) continue;
                    if (frame.data === '[DONE]') { if (!terminal || done) invalid(param); done = true; continue; }
                    if (terminal || done) invalid(param);
                    const event = frame.json as any; if (!event || typeof event !== 'object') invalid(param);
                    if(event.item?.type==='reasoning' || reasoningEvents.has(event.type)){
                        reasoningBytes+=Buffer.byteLength(frame.data);if(reasoningBytes>result.bodyHandle.maxBytes)invalid(param);
                    }
                    if (event.type === 'response.created' || event.type === 'response.in_progress') {
                        if (event.response?.error || ['failed','incomplete','cancelled'].includes(event.response?.status)) invalid(param);
                    } else if (event.type === 'response.output_item.added') {
                        if(!Number.isSafeInteger(event.output_index)||event.output_index<0||event.output_index>=128||event.output_index===callIndex||reasoning.has(event.output_index)||typeof event.item?.id!=='string')invalid(param);
                        if(event.item.type==='reasoning')reasoning.set(event.output_index,{id:event.item.id,done:false});
                        else {
                            if (call || event.item?.type !== 'function_call' || event.item.name !== RELAY_TOOL || event.item.arguments !== '') invalid(param);
                            call = event.item;callIndex=event.output_index;
                        }
                    } else if(reasoningEvents.has(event.type)) {
                        const item=reasoning.get(event.output_index);
                        if(!item || item.done || event.item_id!==item.id)invalid(param);
                    } else if (event.type === 'response.function_call_arguments.delta') {
                        if (!call || outputDone || argumentsDone !== undefined || event.item_id !== call.id || event.output_index !== callIndex || typeof event.delta !== 'string') invalid(param);
                        argumentBytes += Buffer.byteLength(event.delta); if (argumentBytes > result.bodyHandle.maxBytes) invalid(param);
                        args += event.delta;
                    } else if (event.type === 'response.function_call_arguments.done') {
                        if (!call || argumentsDone !== undefined || event.item_id !== call.id || event.output_index !== callIndex || event.arguments !== args) invalid(param);
                        argumentsDone = args;
                    } else if (event.type === 'response.output_item.done') {
                        const thought=reasoning.get(event.output_index);
                        if(thought){if(thought.done || event.item?.id!==thought.id || event.item?.type!=='reasoning')invalid(param);thought.done=true;}
                        else {
                            if (!call || outputDone || argumentsDone === undefined || event.output_index !== callIndex || event.item?.id !== call.id || event.item?.arguments !== args || event.item?.name !== RELAY_TOOL || event.item?.type !== 'function_call' || event.item?.status !== 'completed') invalid(param);
                            outputDone = true;
                        }
                    } else if (event.type === 'response.completed') {
                        if (!call || !outputDone || argumentsDone === undefined || event.response?.output?.[callIndex!]?.id !== call.id || event.response?.output?.[callIndex!]?.arguments !== args || event.response?.output?.length!==reasoning.size+1) invalid(param);
                        for(const [index,thought] of reasoning)if(!thought.done || event.response.output[index]?.id!==thought.id || event.response.output[index]?.type!=='reasoning')invalid(param);
                        response = event.response; payload(response,param); terminal = true;
                    } else invalid(param);
                }
                if (!terminal) invalid(param);
            } finally { await iterator.return?.(); }
        } else if (result.bodyHandle.identity.contentType.includes('json')) response = await result.bodyHandle.json({id:'llm-adapter.relay', mandatory:true, signal});
        else invalid(param);
        const text = payload(response,param);
        signal.throwIfAborted();
        let abort: (()=>void) | undefined;
        const cancelled = new Promise<never>((_,reject)=>{abort=()=>reject(signal.reason ?? new Error('relay_cancelled'));signal.addEventListener('abort',abort,{once:true});});
        let completion;
        try {completion = await Promise.race([result.completion,cancelled]);}
        finally {if(abort)signal.removeEventListener('abort',abort);}
        if (completion.status !== 'completed') invalid(param);
        return text;
    } catch (error) {
        if (signal.aborted) throw error;
        if (error instanceof DataAdmissionError || (error as any)?.admissionError === true) throw error;
        invalid(param);
    } finally { result.dispose(); }
}
