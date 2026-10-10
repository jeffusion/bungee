import { expect, test } from 'bun:test';
import { validateDirectionalRules } from '../../../src/validation/directional-validator';
import { toEditorRoute, toV2Route, toEditorUpstream } from '../../../src/api/config-adapters';
import { compile } from 'svelte/compiler';
import { init, addMessages } from 'svelte-i18n';
addMessages('en', {directional:{invalidExpression:'Invalid expression',invalidFormats:'Invalid formats',sseHeaderDependency:'Invalid SSE headers'}});
await init({fallbackLocale:'en',initialLocale:'en'});

test('directional editor validation matches request and SSE AST rules', () => {
  expect(validateDirectionalRules({request:{headers:{add:{ok:'{{"response.body"}}'}}}})).toEqual([]);
  expect(validateDirectionalRules({request:{headers:{add:{ok:'{{response.headers.ok}}'}}}})).toHaveLength(1);
  expect(validateDirectionalRules({response:{headers:{add:{ok:'{{body.ok}}'}}}})[0]?.field).toBe('response.headers');
  expect(validateDirectionalRules({response:{headers:{add:{ok:'{{body.ok}}'}},body_formats:['json']}})).toEqual([]);
  expect(validateDirectionalRules({response:{body_formats:['json','json']}})[0]?.field).toBe('response.body_formats');
});
test('adapters preserve independent directional rules, identity, and unrelated policies', () => {
  const endpoint:any={id:'upstream-id',position:0,target:'https://example.com',weight:100,priority:1,is_disabled:false,plugins:[],
    request:{headers:{default:{'x-default':'value'}},query:{remove:['secret']},body:{replace:{flag:false}}},
    response:{headers:{add:{'x-response':'yes'}},body:{replace:{value:null}},body_formats:['json']},condition:'{{headers.ok}}',description:'retained'};
  const route:any={id:'route-id',position:0,path:'/api',plugins:[],endpoints:[endpoint],path_rewrite:{'^/api':'/v1'},
    request:{body:{add:{route:true}}},response:{body:{default:{route:true}},body_formats:['sse-json']},timeouts:{request_ms:1200}};
  const logical:any={services:[],routes:[route],plugins:[]};
  expect(toEditorUpstream(endpoint).response).toEqual(endpoint.response);
  expect(toV2Route(toEditorRoute(route,[]),logical,route,0)).toEqual(route);
});
test('route and upstream use the same direction editor and expose format choices', async () => {
  const editor=await Bun.file(new URL('../../../src/components/domain/route/DirectionalModificationEditor.svelte',import.meta.url)).text();
  expect(()=>compile(editor,{filename:'DirectionalModificationEditor.svelte'})).not.toThrow();
  expect(editor).toContain('policy.request.query');expect(editor).toContain('policy.response.body_formats');
  expect(editor).toContain('directional.responseHelp');expect(editor).not.toContain('parseJSON');
});
