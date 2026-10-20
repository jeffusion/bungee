import {expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {PLUGIN_DURABLE_STATE_SCHEMA_SQL,PluginDurableStateStore} from '../../src/plugin-durable-state';
import {createControl} from '../../../../plugins/user-auth/server/control';
import {parseManagementOrigin} from '../../src/master-runtime/management-auth';
test.each(['https://dashboard.example', 'http://dashboard.lan:18090'])('explicit management origin %s works through an HTTP backend with exact Origin and CSRF checks',async publicOrigin=>{
 const db=new Database(':memory:');db.exec(PLUGIN_DURABLE_STATE_SCHEMA_SQL);
 const control=createControl({signal:new AbortController().signal,secretStore:{} as any,storage:{} as any,durableState:new PluginDurableStateStore(db).forNamespace('user-auth'),managementOrigin:parseManagementOrigin(publicOrigin)});
 try{await control.start();expect((await control.initialize(new Request('http://localhost/api/auth/setup',{method:'POST',headers:{origin:publicOrigin},body:JSON.stringify({username:'owner',password:'Owner password 123!',passwordConfirmation:'Owner password 123!'})}))).status).toBe(200);
 const request=(origin:string)=>new Request('http://127.0.0.1:3001/api/auth/login',{method:'POST',headers:{origin,'content-type':'application/json','x-forwarded-host':'untrusted.example'},body:JSON.stringify({username:'owner',password:'Owner password 123!'})});
 const denied=await control.login(request('https://untrusted.example'));expect(denied.status).toBe(403);
 const accepted=await control.login(request(publicOrigin));expect(accepted.status).toBe(200);expect(accepted.headers.get('set-cookie')!.includes('; Secure')).toBe(publicOrigin.startsWith('https:'));
 const body=await accepted.json();const cookie=accepted.headers.get('set-cookie')!.split(';')[0]!;
 expect(()=>control.validateWrite(new Request('http://127.0.0.1:3001/api/config',{method:'PUT',headers:{cookie,origin:publicOrigin,'x-csrf-token':body.csrfToken}}))).not.toThrow();
 expect(()=>control.validateWrite(new Request('http://127.0.0.1:3001/api/config',{method:'PUT',headers:{cookie,origin:publicOrigin}}))).toThrow();
 expect(()=>control.validateWrite(new Request('http://127.0.0.1:3001/api/config',{method:'PUT',headers:{cookie,origin:'http://untrusted.example','x-csrf-token':body.csrfToken,'x-forwarded-host':new URL(publicOrigin).host}}))).toThrow();
 }finally{control.dispose();db.close();}
});


test.each(['ftp://dashboard.example', 'https://user:password@dashboard.example', 'https://dashboard.example/path', 'https://dashboard.example?query=1', 'https://dashboard.example/#fragment'])('management origin rejects non-origin input %s', value => {
 expect(()=>parseManagementOrigin(value)).toThrow();
});
