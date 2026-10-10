import {fieldValueSatisfies} from '../../../../packages/core/src/plugin-manifest-catalog/plugin-field-value';
import {expect,test} from 'bun:test';
import {validateGatewayTargets} from '../../../../packages/core/src/config-storage/gateway-target-validation';
import {ValidationContext} from '../../../../packages/core/src/config-storage/validation';
const schemas=new Map([['router',[{name:'models',type:'array',label:'models',items:{name:'model',type:'object',label:'model',properties:[{name:'target',type:'gateway_target',label:'target'}]}}]]]) as any;
const plugin=(type:string,id:string)=>({id:'binding',position:0,name:'router',enabled:true,options:{models:[{target:{type,id,protocol:'responses'}}]}});
const config=(plugins:any[])=>({routes:[{id:'a',path:'/a',plugins,endpoints:[]},{id:'b',path:'/b',plugins:[],endpoints:[]}],services:[{id:'s',name:'s',plugins:[],endpoints:[]}],plugins:[]}) as any;
test('only declared target references are validated; both scopes work',()=>{
  const context=new ValidationContext();validateGatewayTargets(config([plugin('route','b'),plugin('service','s')]),schemas,context);expect(context.errors).toEqual([]);
});
test('deleted target and self or multi-route cycles prevent publication',()=>{
  for(const target of ['missing','a']) {const context=new ValidationContext();validateGatewayTargets(config([plugin('route',target)]),schemas,context);expect(context.errors.length).toBeGreaterThan(0);}
  const cfg=config([plugin('route','b')]);cfg.routes[1].plugins=[plugin('route','a')];const context=new ValidationContext();validateGatewayTargets(cfg,schemas,context);expect(context.errors[0].message).toContain('cycle');
});

test('target protocol must be explicit',()=>{ const cfg=config([plugin('route','b')]); delete cfg.routes[0].plugins[0].options.models[0].target.protocol;const context=new ValidationContext();validateGatewayTargets(cfg,schemas,context);expect(context.errors[0].message).toContain('protocol'); });

test('binding protocol allows reuse of untyped route/service and preserves cycle validation', () => {
  for (const type of ['route', 'service']) {
    const cfg = config([plugin(type, type === 'route' ? 'b' : 's')]);
    cfg.routes[0].plugins[0].options.models[0].target.protocol = 'chat_completions';
    const context = new ValidationContext(); validateGatewayTargets(cfg, schemas, context); expect(context.errors).toEqual([]);
  }
});

test('gateway reference schema accepts binding protocol but rejects invalid values and extra target keys', () => {
  const field = { name: 'target', type: 'gateway_target', label: 'Target', required: true } as any;
  expect(fieldValueSatisfies(field, { type: 'route', id: 'b' })).toBe(true);
  for (const protocol of ['responses', 'chat_completions', 'anthropic_messages']) expect(fieldValueSatisfies(field, { type: 'service', id: 's', protocol })).toBe(true);
  for (const target of [{ type: 'route', id: 'b', protocol: 'unknown' }, { type: 'route', id: 'b', protocol: null }, { type: 'route', id: 'b', injected: true }, { type: 'service', protocol: 'responses' }]) expect(fieldValueSatisfies(field, target)).toBe(false);
});
