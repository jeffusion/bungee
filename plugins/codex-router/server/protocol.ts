import {protocolSSEOutput,type Plugin,type PluginHooks} from '@jeffusion/bungee-core/plugin';
import {ResponsesEventEncoder,encodeResponsesResult,type ResponsesProtocol,type ResponsesToolNames} from '@jeffusion/bungee-llms/plugin-api';

export function protocolAdapter(input:{protocol?:ResponsesProtocol;model:string;toolNames?:ResponsesToolNames;save:(response:any)=>Promise<void>;signal:AbortSignal}):Plugin {
  const encoder=input.protocol ? new ResponsesEventEncoder(input.protocol,input.model,input.toolNames) : undefined;
  let nativeTerminal:any;
  let flushed=false;
  const terminal=async(events:Record<string,any>[])=>{
    for(const event of events)if(event.response && ['response.completed','response.incomplete'].includes(event.type)) {
      input.signal.throwIfAborted(); await input.save(event.response);
    }
    return events;
  };
  return {
    bodyRequirements(){return {request:'none',response:['json','sse-json']};},
    register(hooks:PluginHooks){
      hooks.onResponse.tapPromise('codex-router.protocol',async(response,context)=>{
        if(!response.ok || !response.headers.get('content-type')?.includes('json'))return response;
        const raw=await context.bodyHandle!.json({id:'codex-router.protocol',mandatory:true});
        const body=input.protocol ? encodeResponsesResult(raw,input.protocol,input.model,input.toolNames) : {...raw as any,model:input.model};
        if(['completed','incomplete'].includes(body.status)){input.signal.throwIfAborted();await input.save(body);}
        const headers=new Headers(response.headers);headers.delete('content-length');headers.delete('content-encoding');headers.set('content-type','application/json');
        return new Response(JSON.stringify(body),{status:response.status,headers});
      });
      hooks.onStreamChunk.tapPromise('codex-router.protocol',async(envelope)=>{
        if(!encoder){
          const event=envelope.json as any;
          if(event?.response && ['response.completed','response.incomplete'].includes(event.type))nativeTerminal={...event.response,model:input.model};
          if(event?.response)return protocolSSEOutput([{...event,response:{...event.response,model:input.model}}],'responses',envelope);
          return [envelope];
        }
        if(envelope.data==='[DONE]')return [];
        const events=await terminal(encoder.push(envelope.json));return protocolSSEOutput(events,'responses',envelope);
      });
      hooks.onFlushStream.tapPromise('codex-router.protocol',async(chunks)=>{
        if(flushed)return chunks;flushed=true;
        if(encoder)return [...chunks,...protocolSSEOutput(await terminal(encoder.finish()),'responses')];
        if(nativeTerminal){input.signal.throwIfAborted();await input.save(nativeTerminal);}
        return chunks;
      });
    },
  };
}
