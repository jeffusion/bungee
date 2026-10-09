import {expect,test} from 'bun:test';
import {validateGatewayTargets} from '../../../packages/core/src/config-storage/gateway-target-validation';
import {ValidationContext} from '../../../packages/core/src/config-storage/validation';
const schemas=new Map([['router',[{name:'models',type:'array',label:'models',items:{name:'model',type:'object',label:'model',properties:[{name:'target',type:'gateway_target',label:'target'}]}}]]]) as any;
const plugin=(type:string,id:string)=>({id:'binding',position:0,name:'router',enabled:true,options:{models:[{target:{type,id}}]}});
const config=(plugins:any[])=>({routes:[{id:'a',path:'/a',plugins,endpoints:[]},{id:'b',path:'/b',plugins:[],endpoints:[]}],services:[{id:'s',name:'s',plugins:[],endpoints:[]}],plugins:[]}) as any;
test('only declared target references are validated; both scopes work',()=>{
  const context=new ValidationContext();validateGatewayTargets(config([plugin('route','b'),plugin('service','s')]),schemas,context);expect(context.errors).toEqual([]);
});
test('deleted target and self or multi-route cycles prevent publication',()=>{
  for(const target of ['missing','a']) {const context=new ValidationContext();validateGatewayTargets(config([plugin('route',target)]),schemas,context);expect(context.errors.length).toBeGreaterThan(0);}
  const cfg=config([plugin('route','b')]);cfg.routes[1].plugins=[plugin('route','a')];const context=new ValidationContext();validateGatewayTargets(cfg,schemas,context);expect(context.errors[0].message).toContain('cycle');
});
