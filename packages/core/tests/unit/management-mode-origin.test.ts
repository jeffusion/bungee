import {expect,test} from 'bun:test';
import {ManagementAuthentication} from '../../src/master-runtime/management-auth';
import {createConfigControlApi} from '../../src/master-runtime/control-api';
test('public auth mode reports the same configured origin used by authentication without trusting forwarded headers',async()=>{
  const keys={list:()=>[]};
  const aggregate={plugin_activations:[]};
  for(const configured of ['https://dashboard.example',undefined]){
    const auth=new ManagementAuthentication({} as any,()=>aggregate as any,new Set(),configured);
    const api=createConfigControlApi({workerCount:1,keyStore:keys,managementAuth:auth} as any);
    const request=new Request('http://127.0.0.1:28089/api/auth/mode',{headers:{'x-forwarded-host':'localhost:60034'}});
    const response=await api.handle(request);
    expect(response?.status).toBe(200);
    expect(await response!.json()).toMatchObject({mode:'anonymous',publicOrigin:configured ?? 'http://127.0.0.1:28089'});
  }
});

test('management setup preserves safe bundled account errors without leaking internal failures', async()=>{
 const {managementSetupFailure}=await import('../../src/master-runtime/management-auth');
 const invalid=managementSetupFailure({code:'invalid_credentials',status:401});
 expect(invalid.status).toBe(422);expect(await invalid.json()).toEqual({error:'invalid_credentials'});
 const unavailable=managementSetupFailure(new Error('sensitive internal database path'));
 expect(unavailable.status).toBe(503);expect(await unavailable.json()).toEqual({error:'management_setup_failed'});
});
