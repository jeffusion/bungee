import { fileURLToPath } from 'node:url';
import { expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {hashConfigurationContent} from '../../src/config-storage/content-hash';
import {
  FIXTURE_PUBLICATION_POLICY, FIXTURE_PUBLICATION_WAIT_MS, FIXTURE_STARTUP_WAIT_MS,
  waitForFixturePublication,
} from '../../../../tests/support/publication-fixture';

test('real master/ingress/worker enforces model policy and honors Authorization header rules', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bungee-key-access-request-'));
  let child: ChildProcess | undefined;
  let output = '', calls = 0;
  const upstream = Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request) {
    calls++;
    return Response.json({model:(await request.json() as {model:string}).model,
      authorization:request.headers.get('authorization'),safeHeader:request.headers.get('x-safe')});
  }});
  const ports: number[] = [];
  for (let i=0; i<4; i++) {
    const listener = Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response()});
    ports.push(listener.port!); await listener.stop(true);
  }
  try {
    const entry = fileURLToPath(new URL('../../src/main.ts', import.meta.url));
    const env = {...process.env,BUNGEE_ROLE:'master',
        BUNGEE_CONFIG_DB_PATH:join(root,'config.db'),BUNGEE_ACCESS_DB_PATH:join(root,'access.db'),
        BUNGEE_INGRESS_INSTANCE_LOCK_PATH:join(root,'ingress.lock'),WORKER_COUNT:'1',
        HOST:'127.0.0.1',PORT:String(ports[0]),BUNGEE_MANAGEMENT_HOST:'127.0.0.1',
        BUNGEE_MANAGEMENT_PORT:String(ports[1]),BUNGEE_MASTER_CONTROL_PORT:String(ports[2]),
        BUNGEE_INGRESS_SUPERVISION_PORT:String(ports[3]),
        BUNGEE_PLUGIN_SECRETS_KEY:Buffer.alloc(32,7).toString('base64'),
        BUNGEE_INCLUDE_SYSTEM_PLUGINS:'false',PLUGINS_DIR:fileURLToPath(new URL('../../../../plugins', import.meta.url))};
    const initialize = Bun.spawn([process.execPath,entry,'--initialize-config',env.BUNGEE_CONFIG_DB_PATH],{cwd:root,env,stdout:'pipe',stderr:'pipe'});
    const [initialized,initializationOutput,initializationErrors] = await Promise.all([initialize.exited,new Response(initialize.stdout).text(),new Response(initialize.stderr).text()]);
    expect(initialized,initializationOutput+'\n'+initializationErrors).toBe(0);
    child = spawn(process.execPath,[entry],{
      cwd:root, env,
      stdio:['ignore','pipe','pipe'],
    });
    child.stdout!.on('data',data=>output+=data); child.stderr!.on('data',data=>output+=data);
    const base = `http://127.0.0.1:${ports[1]}`;
    const headers = {'content-type':'application/json'};
    const waitReady = async (revision: number, timeoutMs: number) => {
      try {
        await waitForFixturePublication({ base, revision, timeoutMs,
          childExited: () => child!.exitCode !== null || child!.signalCode !== null });
      } catch (error) {
        // This child uses only the temporary fixture databases and fake upstream.
        throw new Error(`${error instanceof Error ? error.message : 'fixture readiness failed'}\n${output.slice(-16 * 1024)}`);
      }
    };
    await waitReady(1, FIXTURE_STARTUP_WAIT_MS);
    const serviceId=crypto.randomUUID(),routeId=crypto.randomUUID(),passthroughServiceId=crypto.randomUUID(),stripRouteId=crypto.randomUUID();
    const changed = await fetch(base+'/api/config',{method:'PUT',headers,body:JSON.stringify({
      expected_revision:1,mutation_id:crypto.randomUUID(),aggregate:{
        logical_configuration:{publication:FIXTURE_PUBLICATION_POLICY,plugins:[],services:[{id:serviceId,name:'model-policy-upstream',position:1,plugins:[],
          endpoints:[{id:crypto.randomUUID(),position:1,target:`http://127.0.0.1:${upstream.port}`,weight:100,priority:1,is_disabled:false,plugins:[],
            request: { headers:{add:{Authorization:'Bearer upstream-service-secret','x-safe':'service-header'}} }}]},
          {id:passthroughServiceId,name:'passthrough-upstream',position:2,plugins:[],endpoints:[
            {id:crypto.randomUUID(),position:1,target:`http://127.0.0.1:${upstream.port}`,weight:100,priority:1,is_disabled:false,plugins:[]}]}],
          routes:[{id:routeId,position:1,path:'/v1',service_id:serviceId,plugins:[]},
            {id:crypto.randomUUID(),position:2,path:'/passthrough',service_id:passthroughServiceId,plugins:[]},
            {id:stripRouteId,position:3,path:'/strip',service_id:passthroughServiceId,plugins:[],request: { headers:{remove:['Authorization']} }}]},
        plugin_activations:[{plugin_name:'key-access'}],
      },
    })});
    if (changed.status !== 202) throw Error('configuration commit '+changed.status+' '+await changed.text()+' '+output);
    await waitReady(2, FIXTURE_PUBLICATION_WAIT_MS);
    for (const path of ['passthrough','strip']) {
      const response=await fetch(`http://127.0.0.1:${ports[0]}/${path}/chat/completions`,{method:'POST',
        headers:{'content-type':'application/json',Authorization:'Basic client-upstream-credential','x-safe':'client-header'},
        body:JSON.stringify({model:'public-model'})});
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({model:'public-model',authorization:path==='strip'?null:'Basic client-upstream-credential',safeHeader:'client-header'});
    }
    const issued = await fetch(base+'/api/plugins/key-access/control/credentials',{method:'POST',headers,body:JSON.stringify({name:'Model policy regression'})});
    expect(issued.status).toBe(201); const created=await issued.json(); const key=created.key;
    const policy = await fetch(base+`/api/plugins/key-access/control/keys/${key.id}`,{method:'PUT',headers,
      body:JSON.stringify({routes:[routeId,stripRouteId],models:['allowed-model']})});
    expect(policy.status).toBe(200);
    const open = await fetch(`http://127.0.0.1:${ports[0]}/v1/chat/completions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'public-model'})});
    expect(open.status).toBe(200);
    expect(await open.json()).toEqual({model:'public-model',authorization:'Bearer upstream-service-secret',safeHeader:'service-header'});
    const protectedRoutes=await fetch(base+'/api/plugins/key-access/control/routes',{method:'PUT',headers,body:JSON.stringify({protectedRouteIds:[routeId,stripRouteId]})});
    expect(protectedRoutes.status).toBe(200);
    const catalog=await (await fetch(base+'/api/plugins')).json();
    expect(catalog.find((plugin:{name:string})=>plugin.name==='key-access').blockedReason).toBe('protected_routes_require_plugin');
    const disabled=await fetch(base+'/api/plugins/key-access/disable',{method:'POST',headers,body:'{}'});
    expect(disabled.status).toBe(422);
    expect(await disabled.json()).toMatchObject({error:'protected_routes_require_plugin',plugin:'key-access'});
    const active=await (await fetch(base+'/api/config')).json();
    const unprotected={...active.config,plugin_activations:[]};
    const fullPut=await fetch(base+'/api/config',{method:'PUT',headers,body:JSON.stringify({expected_revision:active.revision,mutation_id:crypto.randomUUID(),aggregate:unprotected})});
    expect(fullPut.status).toBe(422);
    const envelope={format:'bungee-config-snapshot',format_version:1,schema_version:2,exported_at:Date.now(),source_revision:active.revision,content_hash:hashConfigurationContent(unprotected),aggregate:unprotected};
    const imported=await fetch(base+'/api/config/import',{method:'POST',headers,body:JSON.stringify({expected_revision:active.revision,mutation_id:crypto.randomUUID(),envelope:{...envelope,envelope_hash:hashConfigurationContent(envelope)}})});
    expect(imported.status).toBe(422);
    const collection=await (await fetch(base+'/api/resources/api-key')).json();
    expect(collection.keys).toHaveLength(1);
    expect(collection.keys[0]).not.toHaveProperty('digest');
    expect(collection.keys[0]).not.toHaveProperty('token');
    const extensions=await (await fetch(base+`/api/resources/api-key/${key.id}/extensions`)).json();
    expect(extensions.extensions.find((entry:{plugin:string})=>entry.plugin==='key-rate-limit')).toMatchObject({active:false,ready:false,reason:'inactive'});
    const anonymous=await fetch(`http://127.0.0.1:${ports[0]}/v1/chat/completions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'allowed-model'})});
    expect(anonymous.status).toBe(401);
    const send = (model:string) => fetch(`http://127.0.0.1:${ports[0]}/v1/chat/completions`,{
      method:'POST',headers:{authorization:`Bearer ${created.token}`,'content-type':'application/json'},
      body:JSON.stringify({model,messages:[{role:'user',content:'test'}]}),
    });
    const accepted=await send('allowed-model'); expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({model:'allowed-model',authorization:'Bearer upstream-service-secret',safeHeader:'service-header'});
    const stripped=await fetch(`http://127.0.0.1:${ports[0]}/strip/chat/completions`,{method:'POST',
      headers:{authorization:`Bearer ${created.token}`,'content-type':'application/json'},body:JSON.stringify({model:'allowed-model'})});
    expect(stripped.status).toBe(200);
    expect(await stripped.json()).toEqual({model:'allowed-model',authorization:null,safeHeader:null});
    const rejected=await send('allowed-model-suffix'); expect(rejected.status).toBe(403);
    expect(await rejected.json()).toEqual({error:'key-access.scope_denied'});
    expect(calls).toBe(5);
    // Reopen while the credential and its model/route restrictions still exist.
    const publicAgain=await fetch(base+'/api/plugins/key-access/control/routes',{method:'PUT',headers,body:JSON.stringify({protectedRouteIds:[stripRouteId]})});
    expect(publicAgain.status).toBe(200);
    const rebound=await fetch(base+'/api/plugins/key-access/control/route-key',{method:'PUT',headers,body:JSON.stringify({routeId,keyId:key.id})});
    expect(rebound.status).toBe(200);
    expect((await rebound.json()).protectedRouteIds).toEqual([stripRouteId]);
    const publicWithGrant=await fetch(`http://127.0.0.1:${ports[0]}/v1/chat/completions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'public-model'})});
    expect(publicWithGrant.status).toBe(200);
    expect(await publicWithGrant.json()).toEqual({model:'public-model',authorization:'Bearer upstream-service-secret',safeHeader:'service-header'});
    const storedPolicy=await (await fetch(base+`/api/plugins/key-access/control/keys/${key.id}`)).json();
    expect(storedPolicy.value).toEqual({routes:[routeId,stripRouteId],models:['allowed-model']});
    const protectAgain=await fetch(base+'/api/plugins/key-access/control/routes',{method:'PUT',headers,body:JSON.stringify({protectedRouteIds:[routeId,stripRouteId]})});
    expect(protectAgain.status).toBe(200);
    expect((await send('allowed-model-suffix')).status).toBe(403);
    const revoked=await fetch(base+`/api/plugins/key-access/control/credentials/${key.id}`,{method:'DELETE',headers});
    expect(revoked.status).toBe(200);
    expect((await send('allowed-model')).status).toBe(401);
    const revokedMetadata=await (await fetch(base+'/api/resources/api-key')).json();
    expect(revokedMetadata.keys).toHaveLength(0);
    const cleared=await fetch(base+'/api/plugins/key-access/control/routes',{method:'PUT',headers,body:JSON.stringify({protectedRouteIds:[]})});
    expect(cleared.status).toBe(200);
    const reopened=await fetch(`http://127.0.0.1:${ports[0]}/v1/chat/completions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'public-model'})});
    expect(reopened.status).toBe(200);
    expect(await reopened.json()).toEqual({model:'public-model',authorization:'Bearer upstream-service-secret',safeHeader:'service-header'});
  } finally {
    if (child && child.exitCode===null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise(resolve=>child!.once('exit',resolve)),Bun.sleep(10_000)]);
    }
    await upstream.stop(true);
    if (!child || child.exitCode!==null) await rm(root,{recursive:true,force:true});
  }
},FIXTURE_STARTUP_WAIT_MS + FIXTURE_PUBLICATION_WAIT_MS + 45_000);
