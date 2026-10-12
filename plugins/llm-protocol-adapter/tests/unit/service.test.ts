import {expect,test} from 'bun:test';
import {conversionService} from '../../server/service';
import {CatalogView,capabilitiesServiceOf} from '../../../models-dev/server/local';
import {buildCatalogIndex} from '../../../models-dev/server/catalog';
import { readModelIdentity } from '../../contract';
import { MODEL_IDENTITY_ANNOTATION_KEY } from '../../../models-dev/contract';
import { createPluginHooks } from '@jeffusion/bungee-core/plugin';
import AdapterPlugin from '../../server/index';
function fixture(options?:unknown) {
 if(arguments.length===0)options=[{type:'effort',values:['low','high','max']}];
 const view=new CatalogView();
 const load=(version:number,reasoning_options:unknown)=>view.apply(buildCatalogIndex({version,fetchedAt:version,catalog:{zai:{api:'https://test.zai.invalid/api',models:{'glm-5.3-flash':{name:'Flash',reasoning:true,reasoning_options,tool_call:true,limit:{context:32000,output:8192}},'glm-5.3':{name:'GLM',reasoning:true,reasoning_options,tool_call:true,limit:{context:32000,output:8192}}}}}}));
 load(1,options);return {view,load,service:conversionService(capabilitiesServiceOf(view),true)};
}
test('known, empty, missing, invalid, special and non-effort controls never fabricate levels',()=>{
 for(const [options,status,levels] of [[undefined,'missing',[]],[null,'invalid',[]],[[],'known',[]],[[{type:'toggle'}],'known',[]],[[{type:'budget_tokens',min:1024,max:4096}],'known',[]],[[{type:'effort',values:[null,'default','low','high','max','medium']}],'known',['low','high','max']]] as const){
  const {service}=fixture(options);const profile=service.resolveCapabilities({provider:'zai',model:'glm-5.3-flash',targetProtocol:'chat_completions'})!;expect(profile.reasoningOptionsStatus).toBe(status);expect(profile.supportedEfforts).toEqual(levels);expect(profile.defaultEffort).toBe(levels.length?'max':null);
 }
});
test('a supported level without the documented default cannot publish a guessed default',()=>{
 const {service}=fixture([{type:'effort',values:['low','high']}]);expect(service.resolveCapabilities({provider:'zai',model:'glm-5.3-flash',targetProtocol:'chat_completions'})?.supportedEfforts).toEqual([]);
});
test('standalone sessions resolve a unique exact model and every supported effort reaches an enabled target',()=>{
 const {service}=fixture();for(const effort of ['low','high','max']){
 const session=service.createSession({sourceProtocol:'responses',targetProtocol:'chat_completions',model:'glm-5.3-flash'});const result=session.convertRequest({input:'hello',reasoning:{effort}});
 expect(result.body).toMatchObject({reasoning_effort:effort,thinking:{type:'enabled'}});expect(session.validateAttempt({model:'glm-5.3-flash',protocol:'chat_completions',body:result.body})).toMatchObject({effort,catalogVersion:1});
 expect(()=>session.validateAttempt({model:'glm-5.3-flash',protocol:'chat_completions',body:{...result.body,thinking:{type:'disabled'}}})).toThrow();session.dispose();
 }
});
test('directory refresh changes new sessions while an active generation pins its snapshot',()=>{
 const {service,load}=fixture();const s=service.createSession({sourceProtocol:'responses',targetProtocol:'chat_completions',model:'glm-5.3-flash'});const body=s.convertRequest({input:'hello',reasoning:{effort:'low'}}).body;
 load(2,[]);expect(s.validateAttempt({model:'glm-5.3-flash',protocol:'chat_completions',body})).toMatchObject({catalogVersion:1});
 const next=service.createSession({sourceProtocol:'responses',targetProtocol:'chat_completions',model:'glm-5.3-flash'});expect(()=>next.convertRequest({input:'x',reasoning:{effort:'low'}})).toThrow('Selected reasoning effort');
});
test('both explicit ZAI identities preserve wire names, all efforts and a pinned profile',()=>{
 const {service,load}=fixture();
 for(const [model,wireModel] of [['glm-5.3','GLM-5.3'],['glm-5.3-flash','GLM-5.3-Flash']])for(const effort of ['low','high','max']){
  const modelIdentity={wireModel:wireModel!,catalogModel:{provider:'zai',model:model!}};
  const session=service.createSession({sourceProtocol:'responses',targetProtocol:'chat_completions',model:wireModel!,modelIdentity});
  const body=session.convertRequest({model:wireModel,input:'hello',reasoning:{effort}}).body;
  expect(body).toMatchObject({model:wireModel,reasoning_effort:effort,thinking:{type:'enabled'}});
  expect(session.validateAttempt({model:wireModel!,protocol:'chat_completions',body,modelIdentity})).toMatchObject({model:wireModel,catalogModel:modelIdentity.catalogModel,effort,catalogVersion:1});
  expect(()=>session.validateAttempt({model:wireModel!,protocol:'chat_completions',body})).toThrow('Selected reasoning effort');
  expect(()=>session.validateAttempt({model:wireModel!,protocol:'chat_completions',body:{...body,thinking:{type:'disabled'}},modelIdentity})).toThrow('Selected reasoning effort');
  session.dispose();
 }
 const pinned=service.createSession({sourceProtocol:'responses',targetProtocol:'chat_completions',model:'glm-5.3'});
 const body=pinned.convertRequest({input:'hello',reasoning:{effort:'max'}}).body;
 load(2,[]);
 expect(pinned.validateAttempt({model:'GLM-5.3',protocol:'chat_completions',body:{...body,model:'GLM-5.3'},modelIdentity:{wireModel:'GLM-5.3',catalogModel:{provider:'zai',model:'glm-5.3'}}})).toMatchObject({catalogVersion:1,effort:'max'});
 expect(service.resolveCapabilities({provider:'zai',model:'GLM-5.3',targetProtocol:'chat_completions'})).toBeNull();
 expect(service.resolveCapabilities({provider:'zai',model:'GLM-5.3-Flash',targetProtocol:'chat_completions'})).toBeNull();
 pinned.dispose();
});
test('declaration shape, wire mismatch, unknown identity and changed catalog have distinct errors',()=>{
 const {service,load}=fixture();
 const session=service.createSession({sourceProtocol:'responses',targetProtocol:'chat_completions',model:'glm-5.3'});
 const body=session.convertRequest({input:'x',reasoning:{effort:'high'}}).body;
 const validate=(modelIdentity:any)=>session.validateAttempt({model:'WIRE',protocol:'chat_completions',body:{...body,model:'WIRE'},modelIdentity});
 for(const invalid of [Object.assign(Object.create({wireModel:'WIRE',catalogModel:{provider:'zai',model:'glm-5.3'}}),{one:1,two:2}),null,{}, {wireModel:'WIRE',catalogModel:{provider:'zai'}},{wireModel:' WIRE',catalogModel:{provider:'zai',model:'glm-5.3'}},{wireModel:'WIRE',catalogModel:{provider:'zai',model:'glm-5.3',extra:true}}]){
  try{validate(invalid);throw new Error('accepted');}catch(e){expect(e).toMatchObject({code:'invalid_model_identity'});}
 }
 for(const [declaration,code] of [
  [{wireModel:'OTHER',catalogModel:{provider:'zai',model:'glm-5.3'}},'model_identity_mismatch'],
  [{wireModel:'WIRE',catalogModel:{provider:'unknown',model:'glm-5.3'}},'model_identity_unavailable'],
 ] as const){try{validate(declaration);throw new Error('accepted');}catch(e){expect(e).toMatchObject({code});}}
 load(2,[{type:'effort',values:['low','high','max']}]);
 try{validate({wireModel:'WIRE',catalogModel:{provider:'zai',model:'glm-5.3-flash'}});throw new Error('accepted');}catch(e){expect(e).toMatchObject({code:'model_identity_catalog_changed'});}
 session.dispose();
});
test('same wire name with a new catalog identity is not a native exemption',()=>{
 const {service}=fixture();
 const session=service.createSession({sourceProtocol:'responses',targetProtocol:'responses',model:'glm-5.3'});
 const body=session.convertRequest({model:'glm-5.3',input:'x',reasoning:{effort:'low'}}).body;
 expect(session.validateAttempt({model:'glm-5.3',protocol:'responses',body,modelIdentity:{wireModel:'glm-5.3',catalogModel:{provider:'zai',model:'glm-5.3'}}}).effort).toBe('low');
 expect(()=>session.validateAttempt({model:'glm-5.3',protocol:'responses',body,modelIdentity:{wireModel:'glm-5.3',catalogModel:{provider:'zai',model:'glm-5.3-flash'}}})).toThrow('Selected reasoning effort');
 session.dispose();
});
test('late identity pins the first valid snapshot only when effort was not selected',()=>{
 const {service,load}=fixture();
 const session=service.createSession({sourceProtocol:'responses',targetProtocol:'responses',model:'native'});
 const identity={wireModel:'native',catalogModel:{provider:'zai',model:'glm-5.3'}};
 const body=session.convertRequest({model:'native',input:'x'}).body;
 expect(session.validateAttempt({model:'native',protocol:'responses',body,modelIdentity:identity})).toMatchObject({catalogVersion:1});
 load(2,[]);
 expect(session.validateAttempt({model:'native',protocol:'responses',body,modelIdentity:identity})).toMatchObject({catalogVersion:1});
 expect(()=>session.validateAttempt({model:'native',protocol:'responses',body,modelIdentity:{...identity,catalogModel:{provider:'zai',model:'glm-5.3-flash'}}})).toThrow('Target catalog version');
 const unknown=service.createSession({sourceProtocol:'chat_completions',targetProtocol:'chat_completions',model:'native'});
 const selected=unknown.convertRequest({model:'native',messages:[],reasoning_effort:'high'}).body;
 expect(()=>unknown.validateAttempt({model:'native',protocol:'chat_completions',body:selected,modelIdentity:identity})).toThrow('Selected reasoning effort');
 session.dispose();unknown.dispose();
});
test('a genuine model switch keeps route restrictions and checks the final provider thinking rule',()=>{
 const {service}=fixture();
 const profile=service.resolveCapabilities({provider:'zai',model:'glm-5.3',targetProtocol:'chat_completions'})!;
 const session=service.createSession({sourceProtocol:'responses',targetProtocol:'chat_completions',model:'glm-5.3',profile,restrictions:{reasoning:false}});
 const body=session.convertRequest({input:'x',reasoning:{effort:'high'}}).body;
 expect(()=>session.validateAttempt({model:'WIRE',protocol:'chat_completions',body:{...body,model:'WIRE'},modelIdentity:{wireModel:'WIRE',catalogModel:{provider:'zai',model:'glm-5.3-flash'}}})).toThrow('Selected reasoning effort');
 session.dispose();
 const catalog={status:()=>({}),model:({provider,model}:any)=>({provider,model,name:model,catalogVersion:1,reasoning:true,reasoningOptionsStatus:'known',reasoningOptions:[{type:'effort',values:['low','high','max']}],contextWindow:32000,outputLimit:4096,toolCall:true,inputModalities:['text']})};
 const cross=conversionService(catalog as any,true).createSession({sourceProtocol:'chat_completions',targetProtocol:'chat_completions',provider:'other',model:'entry'});
 const raw=cross.convertRequest({model:'entry',messages:[],reasoning_effort:'high'}).body;
 const target={model:'WIRE',protocol:'chat_completions' as const,body:{...raw,model:'WIRE'},modelIdentity:{wireModel:'WIRE',catalogModel:{provider:'zai',model:'glm-5.3'}}};
 expect(()=>cross.validateAttempt(target)).toThrow('Selected reasoning effort'); // changed provider must honor ZAI thinking
 expect(cross.validateAttempt({...target,body:{...raw,model:'WIRE',thinking:{type:'enabled'}}})).toMatchObject({catalogModel:{provider:'zai',model:'glm-5.3'}});
 cross.dispose();
 const native=service.createSession({sourceProtocol:'chat_completions',targetProtocol:'chat_completions',provider:'zai',model:'glm-5.3'});
 const selected=native.convertRequest({model:'glm-5.3',messages:[],reasoning_effort:'high'}).body;
 const changed={model:'WIRE',protocol:'chat_completions' as const,body:{...selected,model:'WIRE'},modelIdentity:{wireModel:'WIRE',catalogModel:{provider:'zai',model:'glm-5.3-flash'}}};
 expect(()=>native.validateAttempt(changed)).toThrow('Selected reasoning effort');
 expect(native.validateAttempt({...changed,body:{...selected,model:'WIRE',thinking:{type:'enabled'}}})).toMatchObject({catalogModel:{provider:'zai',model:'glm-5.3-flash'}});
 native.dispose();
});
test('Gemini final URL model is authoritative with prefixes and encoding, without declarations too',()=>{
 const {service}=fixture();
 const session=service.createSession({sourceProtocol:'gemini_generate_content',targetProtocol:'gemini_generate_content',model:'native'});
 const body={model:'SPOOFED',contents:[]};
 expect(session.validateAttempt({model:'encoded/model',protocol:'gemini_generate_content',body,url:'https://host.invalid/base/v1beta/models/encoded%2Fmodel:generateContent'}).model).toBe('encoded/model');
 expect(session.validateAttempt({model:'GLM-5.3',protocol:'gemini_generate_content',body,url:'https://host.invalid/base/v1beta/models/GLM-5.3:streamGenerateContent',modelIdentity:{wireModel:'GLM-5.3',catalogModel:{provider:'zai',model:'glm-5.3'}}})).toMatchObject({model:'GLM-5.3',catalogVersion:1});
 expect(()=>session.validateAttempt({model:'native',protocol:'gemini_generate_content',body,url:'https://host.invalid/base/v1beta/models/%ZZ:generateContent'})).toThrow('encoding');
 expect(()=>session.validateAttempt({model:'native',protocol:'gemini_generate_content',body,url:'https://host.invalid/invalid:generateContent'})).toThrow('terminal model');
 session.dispose();
});
test('a session without a catalog profile can validate an ordinary converted request',()=>{
 const {service}=fixture();const session=service.createSession({sourceProtocol:'responses',targetProtocol:'chat_completions',model:'unknown-model'});
 const body=session.convertRequest({input:'hello'}).body;
 expect(session.validateAttempt({model:'unknown-model',protocol:'chat_completions',body})).toMatchObject({effort:null,catalogVersion:null});session.dispose();
});
test('ambiguous model IDs cannot infer a provider; explicit provider and declared URL resolve exactly',()=>{
 const {view}=fixture();view.apply(buildCatalogIndex({version:2,fetchedAt:2,catalog:{a:{api:'https://a.invalid/v1',models:{m:{name:'A'}}},b:{api:'https://b.invalid/v1',models:{m:{name:'B'}}}}}));
 const caps=capabilitiesServiceOf(view);expect(caps.model({model:'m'})).toBeNull();expect(caps.model({model:'m',provider:'a'})?.name).toBe('A');expect(caps.model({model:'m',url:'https://b.invalid/v1/chat/completions'})?.name).toBe('B');expect(caps.model({model:'m',url:'https://unknown.invalid/v1'})).toBeNull();
});
test('native passthrough preserves an explicit effort without inventing a conversion rule',()=>{
 const {service}=fixture();const session=service.createSession({sourceProtocol:'responses',targetProtocol:'responses',model:'native-model'});
 const body={model:'native-model',input:'hello',reasoning:{effort:'low'}};expect(session.convertRequest(body).body).toEqual(body);
 expect(()=>session.validateAttempt({model:'native-model',protocol:'responses',body})).not.toThrow();
 expect(()=>session.validateAttempt({model:'native-model',protocol:'responses',body:{...body,reasoning:{effort:'high'}}})).toThrow();
 expect(()=>session.validateAttempt({model:'unknown-target',protocol:'responses',body:{...body,model:'unknown-target'}})).toThrow();session.dispose();
});
test('automatic worker provider consumes its declared history service and disposes the public relay',async()=>{
 const {view}=fixture();let release!:()=>void,published:any;
 const consumes:any[]=[];
 const plugin=new AdapterPlugin();await plugin.init({scope:{type:'global'},initializationKind:'automatic-provider',services:{consume:()=>capabilitiesServiceOf(view),rpc:{consume:(...args:any[])=>{consumes.push(args);return {get:async()=>null,put:async()=>null};}},publish:(...args:any[])=>{published=args;},onDispose:(callback:()=>void)=>release=callback}} as any);
 expect(consumes[0][0]).toBe('llm-protocol-adapter');expect(consumes[0][1].id).toBe('llm-protocol-adapter.history.v1');expect(published[0]).toBe('llm-protocol-adapter.conversion.v1');
 release();await expect(published[2].relayAgentMessage({message:{type:'agent_message',author:'a',recipient:'b',content:[{type:'encrypted_content',encrypted_content:'cipher'}]},contentIndex:0,signal:new AbortController().signal,param:'input[0].content[0].encrypted_content'})).rejects.toMatchObject({code:'llm_adapter_relay_disposed'});
});

test('standalone same-protocol bindings validate identity and preserve response hooks',async()=>{
 const {view}=fixture();
 const plugin=new AdapterPlugin({sourceProtocol:'chat_completions',targetProtocol:'chat_completions'});
 await plugin.init({scope:{type:'route'},services:{consume:()=>capabilitiesServiceOf(view),rpc:{consume:()=>({})},onDispose(){}}} as any);
 const hooks=createPluginHooks();plugin.register(hooks);
 const body={model:'WIRE',messages:[{role:'user',content:'hello'}],reasoning_effort:'high'};
 const ctx:any={requestId:'native',method:'POST',url:new URL('https://target.invalid/v1/chat/completions'),body,annotations:{[MODEL_IDENTITY_ANNOTATION_KEY]:{wireModel:'WIRE',catalogModel:{provider:'zai',model:'glm-5.3'}}}};
 const result=await hooks.onBeforeRequest.promise(ctx);expect(result.body).toBe(body);
 await hooks.onValidateOutbound.promise({...ctx,url:ctx.url.href,model:'WIRE'});
 expect(await hooks.onResponse.promise(new Response(null,{status:503}),ctx)).toBeInstanceOf(Response);
 expect((await hooks.onBeforeRequest.promise(ctx)).body).toBe(body);
 await hooks.onValidateOutbound.promise({...ctx,url:ctx.url.href,model:'WIRE'});
 const response=Response.json({choices:[],extra:'preserved'});
 expect(await hooks.onResponse.promise(response,ctx)).toBe(response);
 for(const [identity,code] of [[null,'llm_adapter_invalid_model_identity'],[{wireModel:'OTHER',catalogModel:{provider:'zai',model:'glm-5.3'}},'llm_adapter_model_identity_mismatch'],[{wireModel:'WIRE',catalogModel:{provider:'unknown',model:'missing'}},'llm_adapter_model_identity_unavailable']] as const){
  await expect(hooks.onBeforeRequest.promise({...ctx,requestId:crypto.randomUUID(),annotations:{[MODEL_IDENTITY_ANNOTATION_KEY]:identity}})).rejects.toMatchObject({status:422,code});
 }
 await hooks.onFinally.promise(ctx);
});
test('declarations are loaded only from host annotations',()=>{
 expect(readModelIdentity()).toBeUndefined();
 expect(readModelIdentity({clientBody:{wireModel:'x',catalogModel:{provider:'zai',model:'x'}}})).toBeUndefined();
});

test('public final validation reads every protocol body instead of trusting its model argument',()=>{
 const {service}=fixture();const session=service.createSession({sourceProtocol:'responses',targetProtocol:'chat_completions',model:'glm-5.3'});
 const body=session.convertRequest({input:'x',reasoning:{effort:'high'}}).body;
 expect(()=>session.validateAttempt({model:'WIRE',protocol:'chat_completions',body:{...body,model:'DIFFERENT-WIRE'},modelIdentity:{wireModel:'WIRE',catalogModel:{provider:'zai',model:'glm-5.3'}}})).toThrow('Declared wire model');
 expect(()=>session.validateAttempt({model:'glm-5.3',protocol:'chat_completions',body:{...body,model:'UNKNOWN'}})).toThrow('Model argument');
 session.dispose();
});
