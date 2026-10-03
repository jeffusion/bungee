import {expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {PLUGIN_DURABLE_STATE_SCHEMA_SQL,PluginDurableStateStore} from '../../src/plugin-durable-state';
import {createControl} from '../../../../plugins/local-accounts/server/control';
import {parseManagementOrigin} from '../../src/master-runtime/management-auth';
test('configured HTTPS management origin works through HTTP backend and marks cookie Secure',async()=>{
 const db=new Database(':memory:');db.exec(PLUGIN_DURABLE_STATE_SCHEMA_SQL);
 const control=createControl({signal:new AbortController().signal,secretStore:{} as any,storage:{} as any,durableState:new PluginDurableStateStore(db).forNamespace('local-accounts'),managementOrigin:parseManagementOrigin('https://dashboard.example')});
 try{await control.start();await control.bootstrap({username:'owner',password:'Owner password 123!',passwordConfirmation:'Owner password 123!'});
 const request=(origin:string)=>new Request('http://127.0.0.1:3001/api/auth/login',{method:'POST',headers:{origin,'content-type':'application/json','x-forwarded-host':'untrusted.example'},body:JSON.stringify({username:'owner',password:'Owner password 123!'})});
 const denied=await control.login(request('https://untrusted.example'));expect(denied.status).toBe(403);
 const accepted=await control.login(request('https://dashboard.example'));expect(accepted.status).toBe(200);expect(accepted.headers.get('set-cookie')).toContain('; Secure');
 const body=await accepted.json();const cookie=accepted.headers.get('set-cookie')!.split(';')[0]!;
 expect(()=>control.validateWrite(new Request('http://127.0.0.1:3001/api/config',{method:'PUT',headers:{cookie,origin:'https://dashboard.example','x-csrf-token':body.csrfToken}}))).not.toThrow();
 }finally{control.dispose();db.close();}
 expect(()=>parseManagementOrigin('http://dashboard.example')).toThrow();expect(()=>parseManagementOrigin('https://dashboard.example/path')).toThrow();
});
