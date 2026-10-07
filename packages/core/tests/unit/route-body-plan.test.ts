import { expect, test } from 'bun:test';
import { buildRouteBodyPlans } from '../../src/master-runtime/route-body-plan';
import { createConfigControlApi } from '../../src/master-runtime/control-api';
import { createManagementAuthFixture } from '../helpers/management-auth';
import { hashConfigurationContent, parseNormalizeCompileAggregate } from '../../src/config-storage';
import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';

function aggregate():ConfigurationAggregateV2 {
  return {logical_configuration:{services:[],plugins:[],routes:[{id:'r',position:0,path:'/test',plugins:[],request:{body:{add:{},remove:[]}},response:{body_formats:['json']},
    endpoints:[{id:'e',position:0,target:'http://upstream.test',priority:1,weight:100,is_disabled:false,plugins:[],
      request:{headers:{add:{'x-model':'{{request.body.model}}'}}},response:{body:{add:{ok:true}},body_formats:['json','sse-json']}}]}]},plugin_activations:[]};
}
test('route plan uses effective direction rules and does not expose rule values or targets',()=>{
  const plans = buildRouteBodyPlans(aggregate());
  expect(plans[0]!.request.mode).toBe('opaque-stream');
  expect(plans[0]!.endpoints[0]!.request.reasons).toContain('request-expression');
  expect(plans[0]!.endpoints[0]!.response.body_formats).toEqual(['json']);
  expect(plans[0]!.endpoints[0]!.response.reasons).toContain('response-body-rules');
  expect(JSON.stringify(plans)).not.toContain('upstream.test');
  expect(JSON.stringify(plans)).not.toContain('{{');
});
test('route-plan management API authenticates and is read only',async()=>{
  const value = aggregate();
  const auth = createManagementAuthFixture(()=>value,{provider:true});
  let commits = 0;
  const api = createConfigControlApi({managementAuth:auth.managementAuth,
    repository:{getSnapshot(){return {revision:2,content_hash:hashConfigurationContent(value),aggregate:value};},getActivePublication(){return null;},getOperationState(){return null;},commit(){commits++;throw new Error('not writable');}},
    admission:{snapshot(){return []; }},workerCount:1,clock:{now:Date.now},resolveAuthToken:x=>x,parseAggregate:parseNormalizeCompileAggregate,
    publicationTasks:{enqueue(){}},isMutationReady:()=>true});
  try {
    expect((await api.handle(new Request('http://control/api/runtime/routes')))!.status).toBe(401);
    const headers = {authorization:`Bearer ${auth.current.token}`};
    const result = (await api.handle(new Request('http://control/api/runtime/routes',{headers})))!;
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({source:'committed_configuration',revision:2,routes:[{route_id:'r'}]});
    // GET performs no publication or configuration writes.
    expect(commits).toBe(0);
  } finally {auth.dispose();}
});
