// Run after bun run build. Optional: --binary /absolute/executable
import { chromium } from 'playwright';
import { captureProcessIdentity, probeProcessIdentity } from '../../packages/core/src/master-runtime/process-identity';
import { waitForAuthPublication } from '../support/auth-publication-readiness';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
const root = await mkdtemp(join(tmpdir(), 'bungee-browser-final-'));
const binaryArgument = process.argv.indexOf('--binary');
const native = binaryArgument >= 0;
if (native && !process.argv[binaryArgument + 1]) throw new Error('--binary requires an executable path');
const password = 'Acceptance '+randomBytes(18).toString('base64url')+'!';
const setup = {username:'acceptance-owner',password,passwordConfirmation:password};
const entry = native ? resolve(process.argv[binaryArgument + 1]!) : resolve(import.meta.dir, '../../packages/core/dist/main.js');
const ports: number[] = [];
for (let i = 0; i < 4; i++) { const server = Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('reserved')}); ports.push(server.port!); await server.stop(true); }
const upstream = Bun.serve({hostname:'127.0.0.1',port:0,fetch: async request => Response.json({message:'storage-acceptance',payload:await request.json()})});
const env = {...process.env, BUNGEE_CONFIG_DB_PATH:join(root,'bungee.db'), BUNGEE_ACCESS_DB_PATH:join(root,'access.db'),
  BUNGEE_BODY_LOG_DIR:join(root,'bodies'), BUNGEE_HEADER_LOG_DIR:join(root,'headers'), BUNGEE_FILE_LOG_DIR:join(root,'files'), DATA_DIR:root,
  BUNGEE_PLUGIN_SECRETS_KEY:randomBytes(32).toString('base64'), BUNGEE_INCLUDE_SYSTEM_PLUGINS:'false',
  PLUGINS_DIR:resolve(import.meta.dir, '../../packages/core/dist/plugins'), HOST:'127.0.0.1', PORT:String(ports[0]),
  BUNGEE_MANAGEMENT_PORT:String(ports[1]), BUNGEE_MASTER_CONTROL_PORT:String(ports[2]), BUNGEE_INGRESS_SUPERVISION_PORT:String(ports[3]), WORKER_COUNT:'1'};
const initialization='--initialize-config';
const init = Bun.spawn(native ? [entry,initialization,env.BUNGEE_CONFIG_DB_PATH] : [process.execPath,entry,initialization,env.BUNGEE_CONFIG_DB_PATH],
  {cwd:root,env,stdout:Bun.file(join(root,'init.log')),stderr:Bun.file(join(root,'init-error.log'))});
if (await init.exited !== 0) throw new Error('formal initialization failed: '+root);
let child: ReturnType<typeof Bun.spawn> | undefined;
const manager = {
  async start(_options: unknown) {
    const args = [`--bungee-process-identity=${crypto.randomUUID()}`];
    child = Bun.spawn(native ? [entry,...args] : [process.execPath,entry,...args],
      {cwd:root,env,stdout:Bun.file(join(root,'daemon.log')),stderr:Bun.file(join(root,'daemon-error.log'))});
  },
  async stop() {
    if(!child) return;
    child.kill('SIGTERM');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([child.exited,new Promise(resolve=>{ timer=setTimeout(()=>resolve('timeout'),20000); })]);
      if(result!==0) throw new Error('formal master graceful exit was not proven: '+result+' '+root);
    } finally { clearTimeout(timer); }
  }
};
const base = `http://127.0.0.1:${ports[1]}`;
const identities = new Map<string, any>();
let browser: any;
let started = false, passed = false;
const wait = async (headers: HeadersInit={},revision?:number) => {
  const runtime = await waitForAuthPublication({base,headers,revision,timeoutMs:45000,childExited:()=>child?.exitCode!==null,childDiagnostic:()=>({root,exit:child?.exitCode})});
  for (const worker of runtime.workers) if (!identities.has(worker.worker_instance_id)) identities.set(worker.worker_instance_id,await captureProcessIdentity(worker.pid,worker.worker_instance_id));
  return runtime;
};
const check = (value: unknown, label: string) => { if (!value) throw new Error(label); };
try {
  await manager.start({workers:'1'}); started=true;
  await wait({},1);
  const enabled = await fetch(base+'/api/plugins/local-accounts/enable',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({expected_revision:1,mutation_id:crypto.randomUUID(),managementSetup:setup})});
  check(enabled.status===202,'account plugin enable failed '+enabled.status);
  const signed = await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:setup.username,password,transport:'bearer'})});
  const session = await signed.json(); check(signed.ok && session.success,'plugin bearer login failed');
  const bearer = {authorization:'Bearer '+session.token};
  await wait(bearer,2);
  check((await fetch(base+'/api/config')).status===401,'anonymous management access was accepted');
  browser = await chromium.launch({headless:true});
  const context = await browser.newContext({viewport:{width:1440,height:1000}});
  const page = await context.newPage();
  const pageErrors: string[] = []; page.on('pageerror',error=>pageErrors.push(error.message));
  await page.goto(base+'/#/login');
  await page.locator('input[autocomplete="username"]').fill(setup.username);
  await page.locator('input[autocomplete="current-password"]').fill(password);
  await page.locator('form button').click();
  await page.locator('[data-testid="page-dashboard"]').waitFor({timeout:20000});
  check((await context.request.get(base+'/api/config')).status()===200,'browser cookie session not authenticated');
  const snapshot = await (await fetch(base+'/api/config',{headers:bearer})).json();
  const serviceId=crypto.randomUUID(), endpointId=crypto.randomUUID(), routeId=crypto.randomUUID();
  const aggregate = {...snapshot.config,logical_configuration:{...snapshot.config.logical_configuration,
    services:[{id:serviceId,position:1,name:'acceptance',plugins:[],endpoints:[{id:endpointId,position:1,target:`http://127.0.0.1:${upstream.port}`,weight:100,priority:1,is_disabled:false,plugins:[]}]}],
    routes:[{id:routeId,position:1,path:'/acceptance',service_id:serviceId,plugins:[]}]}};
  const saved = await fetch(base+'/api/config',{method:'PUT',headers:{...bearer,'content-type':'application/json'},
    body:JSON.stringify({expected_revision:2,mutation_id:crypto.randomUUID(),aggregate})});
  check(saved.status===202,'route commit failed '+saved.status+' '+(saved.status===202?'':await saved.text()));
  await wait(bearer,3);
  const requestBody={marker:crypto.randomUUID(),nested:{value:123}};
  const proxied=await fetch(`http://127.0.0.1:${ports[0]}/acceptance`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(requestBody)});
  const received=await proxied.json(); check(proxied.status===200 && received.message==='storage-acceptance' && JSON.stringify(received.payload)===JSON.stringify(requestBody),'real proxy payload mismatch');
  const health=await (await fetch(base+'/health')).json(); check(health.live && health.management && health.data,'formal health availability mismatch');
  await page.screenshot({path:`/tmp/bungee-${native?'native':'dist'}-dashboard.png`,fullPage:true});
  check(pageErrors.length===0,'browser JavaScript errors: '+pageErrors.join(';'));
  await manager.stop(); started=false;
  await manager.start({workers:'1'}); started=true;
  await wait(bearer,3); await page.reload();
  await page.locator('[data-testid="page-dashboard"]').waitFor({timeout:20000});
  check((await context.request.get(base+'/api/config')).status()===200,'browser session lost after restart');
  check((await fetch(`http://127.0.0.1:${ports[0]}/acceptance`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(requestBody)})).status===200,'proxy failed after restart');
  await page.screenshot({path:`/tmp/bungee-${native?'native':'dist'}-dashboard.png`,fullPage:true});
  console.log(JSON.stringify({artifact:native?'linux-native':'formal-dist',browserLogin:true,cookieAuth:true,proxyPayload:true,restartSession:true,health,jsErrors:pageErrors.length,screenshot:`/tmp/bungee-${native?'native':'dist'}-dashboard.png`}));
  passed=true;
} catch (error) {
  console.log('ACCEPTANCE_FAILED evidence='+root);
  // Private logs and databases remain in the fixture directory on failure.
  throw error;
} finally {
  await browser?.close();
  if(started) await manager.stop();
  for(const identity of identities.values()){const state=await probeProcessIdentity(identity);check(state==='dead'||state==='mismatch','worker exit not proven');}
  await upstream.stop(true);
  for(const port of ports){const server=Bun.serve({hostname:'127.0.0.1',port,reusePort:false,fetch:()=>new Response('closed')});await server.stop(true);}
  if(passed) await rm(root,{recursive:true,force:true});
}
