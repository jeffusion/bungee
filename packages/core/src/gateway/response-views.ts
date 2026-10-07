import { createBodySource } from './body-factory';
import { WATERFALL_VIEW_TRANSFORM } from '../hooks/impl';
import { type BodySource, bodySourceFor, bindBodySource, isJsonMediaType, reconcileEntityHeaders } from '../worker/request/body-source';
import { controlledBodyHandle } from './controlled-views';
import type { BodyHandle, BodyViewIdentity } from './body-contracts';
import type { RawResponseResult } from '../plugin-control/contracts';

/** One current response representation, refreshed after each tap and retained across scopes. */
export class ResponseViews {
  private wire:Response;
  private value:Response;
  private owner?:BodySource;
  private version:number;
  private currentContext?:object;
  private entityHeaders:Headers;
  changed=false;
  constructor(response:Response,private readonly identity:BodyViewIdentity,private readonly maxBytes:number,
    private readonly signal:AbortSignal|undefined,private readonly owners:Array<{dispose():void}>,
    private readonly raw=false,owner?:BodySource) {
    this.wire=response;this.owner=owner;this.version=identity.version;
    this.entityHeaders=new Headers(response.headers);
    this.value=raw?response:this.metadata(response);
  }
  private metadata(response:Response):Response {
    return new Response(null,{status:response.status,statusText:response.statusText,headers:response.headers});
  }
  private handle():BodyHandle|undefined {
    const type=this.value.headers.get('content-type')??'';
    if(!isJsonMediaType(type) && !/^text\/event-stream(?:\s*;|$)/i.test(type) && type)return undefined;
    if(!this.owner && this.wire.body){
      const existing=bodySourceFor(this.wire.body);
      this.owner=existing??createBodySource(this.wire.body,this.maxBytes,this.wire.headers.get('content-encoding')??'',this.signal,this.viewIdentity());
      if(!this.owners.includes(this.owner))this.owners.push(this.owner);
      if(!existing){
        const owned=new Response(this.owner.take(),{status:this.wire.status,statusText:this.wire.statusText,headers:this.wire.headers});
        for(const key of ['url','redirected','type'] as const)Object.defineProperty(owned,key,{value:this.wire[key]});
        this.wire=owned;if(this.raw)this.value=owned;
      }
    }
    return this.owner?controlledBodyHandle(this.owner,this.wire.body,this.owner.handle(this.viewIdentity()),this.signal):undefined;
  }
  private viewIdentity():BodyViewIdentity {
    return {...this.identity,version:this.version,contentType:this.value.headers.get('content-type')??'',contentEncoding:this.value.headers.get('content-encoding')??''};
  }
  context<T extends object>(context:T):T {
    this.currentContext=context;this.updateContext();
    Object.defineProperty(context,WATERFALL_VIEW_TRANSFORM,{value:async(next:Response|RawResponseResult,previous:Response|RawResponseResult)=>{
      const nextResponse=next instanceof Response?next:next.response;
      this.accept(nextResponse);
      return next instanceof Response?this.value:{...next,response:this.value};
    }});
    return context;
  }
  private updateContext():void {
    const handle=this.handle();if(this.currentContext)Object.assign(this.currentContext,{response:this.value,bodyHandle:handle});
  }
  private restoreEntityHeaders(headers:Headers):void {
    for(const name of ['content-encoding','content-length']){
      const value=this.entityHeaders.get(name);if(value===null)headers.delete(name);else headers.set(name,value);
    }
  }
  accept(response:Response):Response {
    if(response!==this.value){
      this.changed=true;this.version++;this.owner=undefined;
      const headers=new Headers(response.headers);reconcileEntityHeaders(headers,response.body,true);
      this.wire=new Response(response.body,{status:response.status,statusText:response.statusText,headers});
      this.entityHeaders=new Headers(headers);
      this.value=this.raw?this.wire:this.metadata(this.wire);
    }
    this.restoreEntityHeaders(this.value.headers);
    this.updateContext();return this.value;
  }
  input():Response {return this.value;}
  source():BodySource|undefined{return this.owner;}
  versionNumber():number{return this.version;}
  materialize(response:Response):Response {
    const body=this.owner?.replayable?this.owner.take():this.wire.body;
    const headers=new Headers(response.headers);
    // Metadata-only callbacks keep the entity represented by the retained wire.
    this.restoreEntityHeaders(headers);
    const result=new Response(body,{status:response.status,statusText:response.statusText,headers});
    if(result.body && this.owner)bindBodySource(result.body,this.owner);
    return result;
  }
}
