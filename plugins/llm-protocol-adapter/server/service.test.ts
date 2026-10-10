import {expect,test} from 'bun:test';
import {conversionService} from './service';
import {CatalogView,capabilitiesServiceOf} from '../../models-dev/server/local';
import {buildCatalogIndex} from '../../models-dev/server/catalog';
function fixture(options?:unknown) {
 if(arguments.length===0)options=[{type:'effort',values:['low','high','max']}];
 const view=new CatalogView();
 const load=(version:number,reasoning_options:unknown)=>view.apply(buildCatalogIndex({version,fetchedAt:version,catalog:{zai:{api:'https://test.zai.invalid/api',models:{'glm-5.3-flash':{name:'Flash',reasoning:true,reasoning_options,tool_call:true,limit:{context:32000,output:8192}}}}}}));
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
