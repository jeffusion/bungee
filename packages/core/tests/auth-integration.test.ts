import {expect,test} from 'bun:test';
import {handleRequest} from '../src/worker/request/handler';
import {initializeRuntimeState,runtimeState} from '../src/worker/state/runtime-state';
import type {AppConfig} from '@jeffusion/bungee-types';

test('base proxy remains public and forwards upstream credentials without an authentication plugin',async()=>{
  const upstream=Bun.serve({hostname:'127.0.0.1',port:0,fetch:request=>Response.json({authorization:request.headers.get('authorization')})});
  const config:AppConfig={routes:[{path:'/api',endpoints:[{target:`http://127.0.0.1:${upstream.port}`}]}]};
  initializeRuntimeState(config);
  try {
    for(const authorization of [null,'Bearer upstream-owned-token']){
      const response=await handleRequest(new Request('http://localhost/api',{headers:authorization?{authorization}:{}}),config);
      expect(response.status).toBe(200);expect(await response.json()).toEqual({authorization});
    }
  }finally{runtimeState.clear();await upstream.stop(true);}
});
