import { describe, expect, test, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import { analyzeExpressionDependencies, hasBodyModification, rewriteLegacyResponseHeaders } from '../../src/utils/expression-dependencies';
import { evaluateExpression, processDynamicValue } from '../../src/expression-engine';
import { parseNormalizeCompileAggregate } from '../../src/config-storage/aggregate';
import { migrateLegacyDirectionalAggregate, type DirectionalMigrationWarning } from '../../src/config-storage/directional-migration';
import { logger } from '../../src/logger';
import { CONFIG_MIGRATIONS, migrateConfigurationDatabase } from '../../src/config-storage/migrations';
import { canonicalJson, hashConfigurationContent, hashConfigurationRequest } from '../../src/config-storage/content-hash';
import { replaceActiveMaterialization } from '../../src/config-storage/materialize';
import { readRepositorySnapshot } from '../../src/config-storage/repository-snapshot';
import { verifySchemaFingerprint } from '../../src/config-storage/schema-fingerprint';
import { getServingSnapshot } from '../../src/config-storage/serving-snapshot';
import { createConfigControlApi } from '../../src/master-runtime/control-api';

const routeId = '10000000-0000-4000-8000-000000000001';
const endpointId = '20000000-0000-4000-8000-000000000001';
function aggregate(route: Record<string, unknown> = {}, endpoint: Record<string, unknown> = {}): any {
  return { logical_configuration: { services: [], plugins: [], routes: [{ id: routeId, position: 0, path: '/api', plugins: [], ...route,
    endpoints: [{ id: endpointId, position: 0, target: 'https://example.com', weight: 100, priority: 1, is_disabled: false, plugins: [], ...endpoint }] }] }, plugin_activations: [] };
}
const legacy = () => aggregate({ headers: { add: { 'x-route': 'route' } }, query: { remove: ['token'] }, body: { add: { route: true } } },
  { headers: { replace: { authorization: '{{headers.authorization}}' } }, body: { replace: { value: '{{headers.token}}', literal: '{{"headers.token"}}' } } });

describe('directional configuration and dependency contracts', () => {
  test('AST distinguishes references from literals, static keys, and request headers', () => {
    expect(analyzeExpressionDependencies({ a: '{{ "body request.body response.body" }}', b: '{{headers.body}}', c: '{{request.headers.body}}' })).toEqual({ requestBody: false, responseBody: false });
    expect(analyzeExpressionDependencies('{{body.model ?? request["body"].model}}')).toEqual({ requestBody: true, responseBody: false });
    expect(analyzeExpressionDependencies('{{request.headers[body.key]}}')).toEqual({ requestBody: true, responseBody: false });
    expect(analyzeExpressionDependencies('{{response?.body?.ok && request.body.ok}}', 'response')).toEqual({ requestBody: true, responseBody: true });
    expect(analyzeExpressionDependencies('{{({body:"text"}).body}}')).toEqual({ requestBody: false, responseBody: false });
    expect(() => analyzeExpressionDependencies('{{response.headers.status}}')).toThrow('unavailable');
    expect(hasBodyModification({ add: {}, remove: [], replace: {}, default: {} })).toBe(false);
    expect(hasBodyModification({ default: { enabled: false } })).toBe(true);
    expect(hasBodyModification({ replace: { value: null } })).toBe(true);
  });
  test('new roots preserve false and null values', () => {
    const context: any = { headers: { current: 'response' }, body: { current: null }, request: { headers: { source: 'request' }, body: { ok: false } },
      response: { headers: { current: 'response' }, body: { current: null } }, url: {pathname:'/', search:'',host:'example.com',protocol:'https:'}, method:'POST', env:{} };
    expect(evaluateExpression('request.body.ok', context)).toBe(false);
    expect(processDynamicValue('{{response.body.current}}', context)).toBeNull();
    expect(processDynamicValue('{{headers.current}}', context)).toBe('response');
  });
  test('compiler rejects old schema, response in request phase, and SSE response-body header dependencies', () => {
    expect(parseNormalizeCompileAggregate(legacy()).ok).toBe(false);
    expect(parseNormalizeCompileAggregate(aggregate({request:{body:{replace:{ok:'{{response.body.ok}}'}}}})).ok).toBe(false);
    expect(parseNormalizeCompileAggregate(aggregate({response:{headers:{add:{ok:'{{body.ok}}'}}}})).ok).toBe(false);
    expect(parseNormalizeCompileAggregate(aggregate({response:{headers:{add:{ok:'{{body.ok}}'}},body_formats:['json']}})).ok).toBe(true);
    expect(parseNormalizeCompileAggregate(aggregate({response:{headers:{add:{ok:'{{request.body.ok}}'}}}})).ok).toBe(true);
    expect(parseNormalizeCompileAggregate(aggregate({}, {condition:'{{response.body.ok}}'})).ok).toBe(false);
    expect(parseNormalizeCompileAggregate(aggregate({response:{body_formats:['json','json']}})).ok).toBe(false);
  });
  test('legacy conversion preserves request rules, response JSON-only behavior, and literal content', () => {
    const input = legacy(); const converted: any = migrateLegacyDirectionalAggregate(input);
    expect(converted.logical_configuration.routes[0].request.body).toEqual(input.logical_configuration.routes[0].body);
    expect(converted.logical_configuration.routes[0].response).toBeUndefined();
    const endpoint = converted.logical_configuration.routes[0].endpoints[0];
    expect(endpoint.response).toEqual({ body:{ replace:{value:'{{request.headers.token}}',literal:'{{"headers.token"}}'} }, body_formats:['json'] });
    expect(endpoint.request.body).toEqual(input.logical_configuration.routes[0].endpoints[0].body);
    expect(parseNormalizeCompileAggregate(converted).ok).toBe(true);
    expect(migrateLegacyDirectionalAggregate(converted)).toEqual(converted);
    expect(rewriteLegacyResponseHeaders('{{({headers, key: "headers"}).headers}}')).toBe('{{({headers: request.headers, key: "headers"}).headers}}');
    expect(parseNormalizeCompileAggregate(migrateLegacyDirectionalAggregate(aggregate({headers:{},request:{}}))).ok).toBe(true);
    expect(parseNormalizeCompileAggregate(migrateLegacyDirectionalAggregate(aggregate({headers:{}},{request:{}}))).ok).toBe(true);
    expect(input.logical_configuration.routes[0].headers).toBeDefined();
  });
});

describe('one-time modification rule cleanup', () => {
  test('new fields win individually, empty blocks disable old fields, and other legacy fields survive', () => {
    const warnings:DirectionalMigrationWarning[]=[];
    const input=aggregate({headers:{add:{legacy:'secret-old'}},body:{add:{keep:false}},query:{remove:['token']},
      request:{headers:{}},response:{headers:{add:{'x-response':'{{headers.status}}'}}}},
      {body:{add:{old:true}},response:{body:{add:{fresh:true}}}});
    const converted:any=migrateLegacyDirectionalAggregate(input,warnings);
    expect(converted.logical_configuration.routes[0].request).toEqual({headers:{},body:{add:{keep:false}},query:{remove:['token']}});
    expect(converted.logical_configuration.routes[0].response.headers.add['x-response']).toBe('{{headers.status}}');
    expect(converted.logical_configuration.routes[0].endpoints[0].request.body).toEqual({add:{old:true}});
    expect(converted.logical_configuration.routes[0].endpoints[0].response).toEqual({body:{add:{fresh:true}}});
    expect(warnings.map(item=>item.reason)).toEqual(['new_format_preferred','new_format_preferred']);
    expect(JSON.stringify(warnings)).not.toContain('secret-old');
    expect(input.logical_configuration.routes[0].headers.add.legacy).toBe('secret-old');
    const again:DirectionalMigrationWarning[]=[]; expect(migrateLegacyDirectionalAggregate(converted,again)).toEqual(converted); expect(again).toEqual([]);
  });
  test('invalid explicit new fields do not resurrect conflicting legacy rules', () => {
    const converted:any=migrateLegacyDirectionalAggregate(aggregate({headers:{add:{old:'old'}},request:{headers:3}}));
    expect(converted.logical_configuration.routes[0].request).toEqual({});
  });
  test('drops only invalid entries, operations and unknown fields, preserving valid expressions and values', () => {
    const warnings:DirectionalMigrationWarning[]=[];
    const converted:any=migrateLegacyDirectionalAggregate(aggregate({headers:{add:{good:'{{headers.good}}',bad:42},remove:['drop',8],unsupported:{a:'b'}},
      body:{add:{ok:false,nil:null,nested:{value:'{{body.name}}'},bad:'{{response.body.name}}',syntax:'{{a(}}'},default:3},query:{replace:{good:'yes',bad:2}}}),warnings);
    expect(converted.logical_configuration.routes[0].request).toEqual({
      headers:{add:{good:'{{headers.good}}'},remove:['drop']},body:{add:{ok:false,nil:null,nested:{value:'{{body.name}}'}}},query:{replace:{good:'yes'}},
    });
    expect(warnings).toHaveLength(7); expect(parseNormalizeCompileAggregate(converted).ok).toBe(true);
  });
  test('bad legacy endpoint response expression cannot discard its valid sibling or request view', () => {
    const converted:any=migrateLegacyDirectionalAggregate(aggregate({}, {body:{replace:{valid:'{{headers.token}}',bad:'{{body(}}',responseOnly:'{{response.body.x}}'}}}));
    const endpoint=converted.logical_configuration.routes[0].endpoints[0];
    expect(endpoint.request.body).toEqual({replace:{valid:'{{headers.token}}'}});
    expect(endpoint.response.body).toEqual({replace:{valid:'{{request.headers.token}}',responseOnly:'{{response.body.x}}'}});
    expect(endpoint.response.body_formats).toEqual(['json']); expect(parseNormalizeCompileAggregate(converted).ok).toBe(true);
  });
  test('invalid response selector drops its body without broadening formats and retains static headers', () => {
    const converted:any=migrateLegacyDirectionalAggregate(aggregate({response:{body_formats:['xml'],body:{add:{unexpected:true}},headers:{add:{static:'ok',dynamic:'{{body.x}}'}},query:{add:{bad:'bad'}}}}));
    expect(converted.logical_configuration.routes[0].response).toEqual({headers:{add:{static:'ok'}}});
    expect(parseNormalizeCompileAggregate(converted).ok).toBe(true);
  });
  test('new selectors cannot move inherited legacy response rules beyond their JSON-only boundary', () => {
    for (const formats of [[],['sse-json'],['json','sse-json'],['xml']]) {
      const warnings:DirectionalMigrationWarning[]=[];
      const converted:any=migrateLegacyDirectionalAggregate(aggregate({}, {body:{add:{legacy:true}},response:{body_formats:formats,headers:{add:{keep:'{{headers.status}}'}}}}),warnings);
      const endpoint=converted.logical_configuration.routes[0].endpoints[0];
      expect(endpoint.request.body).toEqual({add:{legacy:true}}); expect(endpoint.response).not.toHaveProperty('body');
      expect(endpoint.response.headers.add.keep).toBe('{{headers.status}}');
      expect(warnings).toContainEqual({path:'logical_configuration.routes[0].endpoints[0].body',reason:'new_format_preferred'});
      expect(parseNormalizeCompileAggregate(converted).ok).toBe(true);
    }
    const converted:any=migrateLegacyDirectionalAggregate(aggregate({}, {
      body:{add:{legacy:true}}, response:{body_formats:['json'],headers:{add:{keep:'{{headers.status}}'}}},
    }));
    expect(converted.logical_configuration.routes[0].endpoints[0].response.body).toEqual({add:{legacy:true}});
    expect(converted.logical_configuration.routes[0].endpoints[0].response.headers.add.keep).toBe('{{headers.status}}');
    const explicit:any=migrateLegacyDirectionalAggregate(aggregate({}, {body:{add:{legacy:true}},response:{body_formats:['sse-json'],body:{add:{new:true}}}}));
    expect(explicit.logical_configuration.routes[0].endpoints[0].response).toEqual({body_formats:['sse-json'],body:{add:{new:true}}});
  });
  test('service-level modifications are ignored while service endpoints still convert', () => {
    const input=aggregate(); input.logical_configuration.services=[{id:'30000000-0000-4000-8000-000000000001',position:0,name:'service',plugins:[],
      headers:{add:{ignored:'yes'}},request:{body:{add:{ignored:true}}},endpoints:[{...structuredClone(input.logical_configuration.routes[0].endpoints[0]),id:'40000000-0000-4000-8000-000000000001',body:{add:{keep:true}}}]}];
    const warnings:DirectionalMigrationWarning[]=[]; const converted:any=migrateLegacyDirectionalAggregate(input,warnings);
    const service=converted.logical_configuration.services[0]; expect(service).not.toHaveProperty('headers'); expect(service).not.toHaveProperty('request');
    expect(service.endpoints[0].request.body).toEqual({add:{keep:true}}); expect(service.endpoints[0].response.body_formats).toEqual(['json']);
    expect(warnings.map(item=>item.reason)).toEqual(['unsupported_service_modification','unsupported_service_modification']);
    expect(parseNormalizeCompileAggregate(converted).ok).toBe(true);
  });
  test('cleanup never changes invalid targets, protection, plugin options, or non-modification fields', () => {
    const input=aggregate({auth:{enabled:true,tokens:[]},unexpected:'keep',request:{body:{add:{bad:'{{response.body.x}}'}}}},{target:'not-a-url'});
    const converted:any=migrateLegacyDirectionalAggregate(input);
    expect(converted.logical_configuration.routes[0].auth).toEqual(input.logical_configuration.routes[0].auth);
    expect(converted.logical_configuration.routes[0].unexpected).toBe('keep');
    expect(converted.logical_configuration.routes[0].endpoints[0].target).toBe('not-a-url'); expect(parseNormalizeCompileAggregate(converted).ok).toBe(false);
  });
});

test('sealed legacy import validates original hashes and commits converted schema', async () => {
  const old=legacy(); const current:any={revision:1,content_hash:hashConfigurationContent(aggregate()),aggregate:aggregate()};
  let committed:any;
  const operation:any={mutation_id:'legacy-import',committed_revision:2,state:'committed'};
  const api=createConfigControlApi({ workerCount:1, repository: { getSnapshot:()=>current, getOperationState:async()=>({operation,workers:[]}),
    getActivePublication:async()=>null, commit:async(command:any)=>{committed=command;return {kind:'committed',snapshot:current,operation};} },
    managementAuth:{authenticate:async()=>({}),recheck:async()=>true,identity:()=>({}),authorized:async()=>true,validateWrite:async()=>{},selected:()=>null},
    parseAggregate:parseNormalizeCompileAggregate, publicationTasks:{enqueue:()=>{}}, admission:{snapshot:()=>[]}, clock:{now:()=>1},
    isMutationReady:()=>true, resolveAuthToken:(value:any)=>value,
  } as any);
  const base={format:'bungee-config-snapshot',format_version:1,schema_version:2,exported_at:1,source_revision:2,content_hash:hashConfigurationContent(old),aggregate:old};
  const envelope={...base,envelope_hash:hashConfigurationContent(base)};
  const response=await api.handle(new Request('http://localhost/api/config/import',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expected_revision:1,mutation_id:'legacy-import',envelope})}));
  expect(response?.status).toBe(202); expect(committed.aggregate).toEqual(migrateLegacyDirectionalAggregate(old));
});

function sealed(input: unknown): any {
  const base={format:'bungee-config-snapshot',format_version:1,schema_version:2,exported_at:1,source_revision:2,
    content_hash:hashConfigurationContent(input as ConfigurationAggregateV2),aggregate:input};
  return {...base,envelope_hash:hashConfigurationContent(base)};
}
function importHarness() {
  const current:any={revision:1,content_hash:hashConfigurationContent(aggregate()),aggregate:aggregate()};
  const operation:any={mutation_id:'legacy-import',committed_revision:2,state:'committed'};
  const commands:any[]=[];
  const api=createConfigControlApi({workerCount:1,repository:{getSnapshot:()=>current,getOperationState:async()=>({operation,workers:[]}),
    getActivePublication:async()=>null,commit:async(command:any)=>{commands.push(command);return {kind:'committed',snapshot:current,operation};}},
    managementAuth:{authenticate:async()=>({}),recheck:async()=>true,identity:()=>({}),authorized:async()=>true,validateWrite:async()=>{},selected:()=>null},
    parseAggregate:parseNormalizeCompileAggregate,publicationTasks:{enqueue:()=>{}},admission:{snapshot:()=>[]},clock:{now:()=>1},
    isMutationReady:()=>true,resolveAuthToken:(value:any)=>value,
  } as any);
  const request=(path:string,body:unknown)=>api.handle(new Request(`http://localhost/api/config/${path}`,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));
  return {commands,request};
}
test('sealed preview and import share local cleanup, report warnings, and leave preview read-only', async () => {
  const {commands,request}=importHarness();
  const input=aggregate({headers:{add:{old:'old'}},request:{headers:{add:{good:'yes',bad:2}}}},{body:{add:{keep:true,bad:'{{body(}}'}}});
  const original=JSON.stringify(input); const envelope=sealed(input);
  const preview=await request('validate',{envelope}); expect(preview?.status).toBe(200);
  const report:any=await preview!.json(); expect(report.valid).toBe(true); expect(commands).toEqual([]);
  expect(report.warnings.length).toBe(4); expect(report.aggregate.logical_configuration.routes[0].request.headers).toEqual({add:{good:'yes'}});
  const warn=spyOn(logger,'warn').mockImplementation(()=>logger); try {
    const response=await request('import',{expected_revision:1,mutation_id:'legacy-import',envelope}); expect(response?.status).toBe(202);
    const accepted:any=await response!.json(); expect(accepted.warnings).toEqual(report.warnings);
    expect(commands).toHaveLength(1); expect(commands[0].aggregate).toEqual(report.aggregate); expect(warn).toHaveBeenCalledTimes(1);
  } finally {warn.mockRestore();}
  expect(JSON.stringify(input)).toBe(original);
});
test('snapshot hash mismatch is rejected before cleanup; invalid targets are never ignored', async () => {
  for (const path of ['validate','import']) {
    const {commands,request}=importHarness();
    const altered=sealed(legacy()); altered.aggregate.logical_configuration.routes[0].body.add.bad='{{body(}}';
    const body=(envelope:unknown)=>path==='validate'?{envelope}:{expected_revision:1,mutation_id:'legacy-import',envelope};
    expect((await request(path,body(altered)))?.status).toBe(400);
    const invalid=sealed(aggregate({body:{add:{bad:'{{body(}}'}}},{target:'invalid-target'}));
    expect((await request(path,body(invalid)))?.status).toBe(422); expect(commands).toEqual([]);
  }
});
test('normal editing and validation remain strict; import cleanup is not a runtime compatibility path', async () => {
  const {commands,request}=importHarness();
  const response=await request('validate',{aggregate:legacy()}); const report:any=await response!.json();
  expect(report.valid).toBe(false); expect(commands).toEqual([]);
  expect((await request('validate',{aggregate:aggregate(),envelope:sealed(legacy())}))?.status).toBe(400);
});
