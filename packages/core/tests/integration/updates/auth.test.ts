import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigRepository, parseNormalizeCompileAggregate } from '../../../src/config-storage';
import { configurationRepositoryFixture } from '../../helpers/config-repository';
import { createManagementAuthFixture } from '../../helpers/management-auth';
import { createConfigControlApi } from '../../../src/master-runtime/control-api';
import { WorkerAdmissionRegistry } from '../../../src/public-listener';
import { UpdateController } from '../../../src/updates/controller';
import { createDaemonShutdownHandler } from '../../../src/daemon-control';
import { DAEMON_UPDATES_PATH, type DaemonMetadataArmed } from '@jeffusion/bungee-types';

test('update routes preserve management authentication, capabilities and explicit browser origin', async () => {
  const root=mkdtempSync(join(tmpdir(),'bungee-update-auth-'));
  const repository=ConfigRepository.open(join(root,'config.db'));
  const credential=createManagementAuthFixture(()=>repository.getSnapshot().aggregate,{provider:true});
  const controller=new UpdateController({version:'6.6.0',compiled:false});
  try{
    const api=createConfigControlApi({managementAuth:credential.managementAuth,repository:configurationRepositoryFixture(repository),
      admission:new WorkerAdmissionRegistry(),workerCount:1,clock:{now:()=>Date.now()},resolveAuthToken:value=>value,
      parseAggregate:parseNormalizeCompileAggregate,publicationTasks:{enqueue(){ }},isMutationReady:()=>true,updates:controller});
    expect((await api.handle(new Request('http://management.test/api/system/updates')))!.status).toBe(401);
    expect((await api.handle(new Request('http://management.test/api/system/updates/confirm',{method:'POST',body:'{}'})))!.status).toBe(401);
    const headers={authorization:`Bearer ${credential.current.token}`};
    expect((await api.handle(new Request('http://management.test/api/system/updates',{headers})))!.status).toBe(200);
    expect((await api.handle(new Request('http://management.test/api/system/updates',{method:'POST',headers:{...headers,origin:'https://other.test'},body:'{}'})))!.status).toBe(403);
    expect((await api.handle(new Request('http://management.test/api/system/updates/confirm',{method:'POST',headers:{...headers,origin:'https://other.test'},body:'{}'})))!.status).toBe(403);
    credential.sessions.revoke(credential.current.id);
    expect((await api.handle(new Request('http://management.test/api/system/updates',{headers})))!.status).toBe(401);
  }finally{controller.cancel();credential.dispose();repository.close();rmSync(root,{recursive:true,force:true});}
});

test('private upgrade routes require the exact local daemon authority and never invoke shutdown', async () => {
  const metadata:DaemonMetadataArmed={schema:'bungee-daemon-metadata-v1',state:'armed',pid:1234,launcher_pid:5678,
    boot_nonce:'abcdef12-3456-7890-abcd-ef1234567890',instance_id:'00000000-0000-0000-0000-000000000002',
    management_host:'127.0.0.1',management_port:8089,executable:'/tmp/bungee',entrypoint:null,
    shutdown_secret:'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'};
  let reads=0,shutdowns=0;
  const handler=createDaemonShutdownHandler({metadata,onShutdownRequested(){shutdowns++;},updates:{async handle(request,privateControl){expect(privateControl).toBe(true);reads++;return Response.json({running_version:'6.6.0'});}}});
  // Use the exported wire names rather than assuming a public management credential grants local ownership.
  const {DAEMON_AUTHORIZATION_HEADER,DAEMON_BOOT_HEADER,DAEMON_INSTANCE_HEADER,DAEMON_PID_HEADER}=await import('@jeffusion/bungee-types');
  const valid={[DAEMON_AUTHORIZATION_HEADER]:`Bearer ${metadata.shutdown_secret}`,[DAEMON_BOOT_HEADER]:metadata.boot_nonce,
    [DAEMON_INSTANCE_HEADER]:metadata.instance_id,[DAEMON_PID_HEADER]:String(metadata.pid)};
  for(const changes of [{[DAEMON_PID_HEADER]:'1235'},{[DAEMON_BOOT_HEADER]:crypto.randomUUID()},{[DAEMON_AUTHORIZATION_HEADER]:'Bearer invalid'}]){
    expect((await handler.handle(new Request(`http://127.0.0.1${DAEMON_UPDATES_PATH}`,{headers:{...valid,...changes}}))).status).toBe(404);
  }
  expect(reads).toBe(0);
  expect((await handler.handle(new Request(`http://127.0.0.1${DAEMON_UPDATES_PATH}`,{headers:valid}))).status).toBe(200);
  expect(reads).toBe(1);expect(shutdowns).toBe(0);expect(handler.accepted).toBe(false);
});
