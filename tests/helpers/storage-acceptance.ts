import { waitUntil } from './gateway-runtime';
import { runRecoveryInTerminal, identityRecoveryAnswers } from './recovery-terminal';
import { prepareManagementInitialization } from './management-initialization';
// Run after bun run build. Optional: --binary /absolute/executable
import { chromium } from 'playwright';
import { captureProcessIdentity, probeProcessIdentity } from '../../packages/core/src/master-runtime/process-identity';
import { waitForAuthPublication } from './auth-publication-readiness';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
export async function runStorageAcceptance(binary?: string) {
const root = await mkdtemp(join(tmpdir(), 'bungee-storage-browser-'));
const evidence = await mkdtemp(join(tmpdir(), 'bungee-storage-evidence-'));
const native = binary !== undefined;
const password = randomBytes(3).toString('base64url')+'!';
const setup = {username:'acceptance-owner',password,passwordConfirmation:password};
const entry = native ? resolve(binary!) : resolve(import.meta.dir, '../../packages/core/dist/main.js');
const ports: number[] = [];
let upstream: ReturnType<typeof Bun.serve> | undefined;
const env = {...process.env, BUNGEE_CONFIG_DB_PATH:join(root,'bungee.db'), BUNGEE_ACCESS_DB_PATH:join(root,'access.db'),
  BUNGEE_BODY_LOG_DIR:join(root,'bodies'), BUNGEE_HEADER_LOG_DIR:join(root,'headers'), BUNGEE_FILE_LOG_DIR:join(root,'files'), DATA_DIR:root,
  BUNGEE_PLUGIN_SECRETS_KEY:randomBytes(32).toString('base64'), BUNGEE_INCLUDE_SYSTEM_PLUGINS:'false',
  PLUGINS_DIR:resolve(import.meta.dir, '../../packages/core/dist/plugins'), HOST:'127.0.0.1', BUNGEE_MANAGEMENT_HOST:'127.0.0.1', PORT:String(ports[0]),
  BUNGEE_MANAGEMENT_PORT:String(ports[1]), BUNGEE_MASTER_CONTROL_PORT:String(ports[2]), BUNGEE_INGRESS_SUPERVISION_PORT:String(ports[3]), WORKER_COUNT:'1'};
const initialization='--initialize-config';
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
let base: string;
const identities = new Map<string, any>();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let started = false, passed = false;
const wait = async (headers: HeadersInit={},revision?:number) => {
  const runtime = await waitForAuthPublication({base,headers,revision,timeoutMs:45000,childExited:()=>child?.exitCode!==null,childDiagnostic:()=>({root,exit:child?.exitCode})});
  for (const worker of runtime.workers) if (!identities.has(worker.worker_instance_id)) identities.set(worker.worker_instance_id,await captureProcessIdentity(worker.pid,worker.worker_instance_id));
  return runtime;
};
const check = (value: unknown, label: string) => { if (!value) throw new Error(label); };
try {
  for (let i = 0; i < 4; i++) { const server = Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('reserved')}); ports.push(server.port!); await server.stop(true); }
upstream = Bun.serve({hostname:'127.0.0.1',port:0,fetch: async request => Response.json({message:'storage-acceptance',payload:await request.json()})});
  Object.assign(env,{PORT:String(ports[0]),BUNGEE_MANAGEMENT_PORT:String(ports[1]),BUNGEE_MASTER_CONTROL_PORT:String(ports[2]),BUNGEE_INGRESS_SUPERVISION_PORT:String(ports[3])});
  const init = Bun.spawn(native ? [entry,initialization,env.BUNGEE_CONFIG_DB_PATH] : [process.execPath,entry,initialization,env.BUNGEE_CONFIG_DB_PATH],
  {cwd:root,env,stdout:Bun.file(join(root,'init.log')),stderr:Bun.file(join(root,'init-error.log'))});
if (await boundedExit(init, 20_000) !== 0) throw new Error('formal initialization failed: '+root);
  base = `http://127.0.0.1:${ports[1]}`;
  const prepared = await prepareManagementInitialization(env.BUNGEE_CONFIG_DB_PATH, env.PLUGINS_DIR);
  await manager.start({workers:'1'}); started=true;
  await waitUntil(async () => {
    if (child?.exitCode !== null) throw new Error('master exited before setup readiness');
    const response = await fetch(base + '/api/auth/setup');
    return response.ok && (await response.json()).initialized === false;
  }, 'management setup did not become ready', 45000);
  browser = await chromium.launch({headless:true});
  const context = await browser.newContext({viewport:{width:390,height:844},locale:'zh-CN'});
  await context.addInitScript(() => { if (location.protocol === 'http:' || location.protocol === 'https:') localStorage.setItem('locale','zh-CN'); });
  const page = await context.newPage();
  const waitForDashboard = async () => {
    await page.getByTestId('page-dashboard').waitFor({timeout:20000});
    // The dashboard mounts before its plugin and menu requests finish.
    // Settle them before this acceptance deliberately navigates away or reloads.
    await page.waitForLoadState('networkidle');
  };
  const pageErrors: string[] = [], consoleErrors: string[] = [];
  let expectedLogoutFailure = false;
  page.on('pageerror',error=>pageErrors.push(error.message));
  page.on('console',message=>{if(message.type()==='error' && !(expectedLogoutFailure && message.location().url.endsWith('/api/auth/logout'))) consoleErrors.push(message.text());});
  await page.route('https://fonts.googleapis.com/**',route=>route.fulfill({contentType:'text/css',body:''}));
  await page.goto(base+'/#/setup');
  await page.locator('input[autocomplete="off"]').waitFor();
  await page.screenshot({path:join(evidence,'mobile-setup.png'),fullPage:true});
  await page.locator('input[autocomplete="off"]').fill(prepared.code);
  await page.locator('input[autocomplete="username"]').fill(setup.username);
  await page.locator('input[autocomplete="new-password"]').nth(0).fill(password);
  await page.locator('input[autocomplete="new-password"]').nth(1).fill(password);
  await page.locator('form button').click();
  await page.waitForURL(base+'/#/login');
  await page.locator('input[autocomplete="current-password"]').waitFor();
  check(page.url().endsWith('/#/login'),'setup did not return to login');
  check((await context.request.get(base+'/api/config')).status()===401,'setup created an authenticated session');
  const signed = await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:setup.username,password,transport:'bearer'})});
  const session = await signed.json(); check(signed.ok && session.success,'plugin bearer login failed');
  const bearer = {authorization:'Bearer '+session.token};
  await wait(bearer,prepared.revision);
  check((await fetch(base+'/api/config')).status===401,'anonymous management access was accepted');
  await page.setViewportSize({width:1440,height:1000});
  await page.goto(base+'/#/login');
  await page.locator('input[autocomplete="username"]').fill(setup.username);
  await page.locator('input[autocomplete="current-password"]').fill(password);
  await page.locator('form button').click();
  await waitForDashboard();
  await page.screenshot({path:join(evidence,'login-dashboard.png'),fullPage:true});
  const browserConfig = await context.request.get(base+'/api/config');
  check(browserConfig.status()===200,'browser cookie session not authenticated '+browserConfig.status()+' '+(browserConfig.ok() ? '' : await browserConfig.text()));
  const snapshot = await (await fetch(base+'/api/config',{headers:bearer})).json();
  const serviceId=crypto.randomUUID(), endpointId=crypto.randomUUID(), routeId=crypto.randomUUID();
  const aggregate = {...snapshot.config,logical_configuration:{...snapshot.config.logical_configuration,
    services:[{id:serviceId,position:1,name:'acceptance',plugins:[],endpoints:[{id:endpointId,position:1,target:`http://127.0.0.1:${upstream!.port}`,weight:100,priority:1,is_disabled:false,plugins:[]}]}],
    routes:[{id:routeId,position:1,path:'/acceptance',service_id:serviceId,plugins:[]}]}};
  const saved = await fetch(base+'/api/config',{method:'PUT',headers:{...bearer,'content-type':'application/json'},
    body:JSON.stringify({expected_revision:prepared.revision,mutation_id:crypto.randomUUID(),aggregate})});
  check(saved.status===202,'route commit failed '+saved.status+' '+(saved.status===202?'':await saved.text()));
  await wait(bearer,prepared.revision+1);
  const requestBody={marker:crypto.randomUUID(),nested:{value:123}};
  const proxied=await fetch(`http://127.0.0.1:${ports[0]}/acceptance`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(requestBody)});
  const received=await proxied.json(); check(proxied.status===200 && received.message==='storage-acceptance' && JSON.stringify(received.payload)===JSON.stringify(requestBody),'real proxy payload mismatch');
  const health=await (await fetch(base+'/health')).json(); check(health.live && health.management && health.data,'formal health availability mismatch');
  await page.screenshot({path:join(evidence,'dashboard.png'),fullPage:true});
  check(pageErrors.length===0,'browser JavaScript errors: '+pageErrors.join(';'));
  await page.goto('about:blank');
  await manager.stop(); started=false;
  await manager.start({workers:'1'}); started=true;
  await wait(bearer,prepared.revision+1); await page.goto(base+'/#/');
  await waitForDashboard();
  check((await context.request.get(base+'/api/config')).status()===200,'browser session lost after restart');
  check((await fetch(`http://127.0.0.1:${ports[0]}/acceptance`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(requestBody)})).status===200,'proxy failed after restart');
  await page.screenshot({path:join(evidence,'dashboard.png'),fullPage:true});
  const messages = (await Bun.file(resolve(import.meta.dir,'../../plugins/user-auth/manifest.json')).json()).translations['zh-CN'];
  const changedPassword=randomBytes(24).toString('base64url');
  await page.goto(base+'/#/extensions/user-auth/profile');
  const settings=page.getByTestId('auth-user-profile');await settings.waitFor();
  await settings.getByRole('button',{name:messages['profile.changePassword'],exact:true}).click();
  const passwordDialog=page.getByRole('dialog');
  await passwordDialog.getByLabel(messages['settings.currentPassword'],{exact:true}).fill(password);
  await passwordDialog.getByLabel(messages['settings.newPassword'],{exact:true}).fill(changedPassword);
  await passwordDialog.getByLabel(messages['settings.confirmation'],{exact:true}).fill(changedPassword);
  await passwordDialog.getByRole('button',{name:messages['settings.submit'],exact:true}).click();
  await page.waitForURL(base+'/#/login');
  await page.locator('input[autocomplete="current-password"]').waitFor();
  check((await fetch(base+'/api/auth/verify',{headers:bearer})).status===401,'password change retained the old Bearer');
  await page.locator('input[autocomplete="username"]').fill(setup.username);
  await page.locator('input[autocomplete="current-password"]').fill(changedPassword);
  await page.locator('form button').click();await waitForDashboard();
  await page.goto(base+'/#/extensions/user-auth/profile');await settings.waitFor();
  expectedLogoutFailure=true;
  await page.route('**/api/auth/logout',route=>route.fulfill({status:503,json:{error:'provider_unavailable'}}));
  await settings.getByRole('button',{name:messages['settings.logout'],exact:true}).click();
  await settings.getByRole('alert').waitFor();
  check((await context.request.get(base+'/api/config')).status()===200,'failed logout cleared the valid session');
  await page.screenshot({path:join(evidence,'logout-failure-preserved.png'),fullPage:true});
  await page.unroute('**/api/auth/logout');expectedLogoutFailure=false;
  await settings.getByRole('button',{name:messages['settings.logout'],exact:true}).click();
  await page.waitForURL(base+'/#/login');
  await page.locator('input[autocomplete="current-password"]').waitFor();
  check((await context.request.get(base+'/api/config')).status()===401,'successful logout retained session');
  await page.goto('about:blank');
  await manager.stop();started=false;
  const recoveredPassword=randomBytes(24).toString('base64url');
  const args=['--recover',env.BUNGEE_CONFIG_DB_PATH,'--plugin','user-auth','--action','reset'];
  const recovery=await runRecoveryInTerminal(native?[entry,...args]:[process.execPath,entry,...args],
    {cwd:root,env},identityRecoveryAnswers('recovered-owner',recoveredPassword,'Browser recovery acceptance'));
  check(recovery.code===0,'local account recovery failed');
  check(!recovery.output.includes(recoveredPassword),'recovery leaked password');
  await manager.start({workers:'1'});started=true;
  await waitUntil(async()=>{try{return (await fetch(base+'/api/auth/mode')).ok;}catch{return false;}},'restored instance unavailable',45000);
  await page.setViewportSize({width:390,height:844});await page.goto(base+'/#/login');
  await page.locator('input[autocomplete="username"]').fill('recovered-owner');
  await page.locator('input[autocomplete="current-password"]').fill(recoveredPassword);
  await page.locator('form button').click();await waitForDashboard();
  await page.reload();await waitForDashboard();
  await page.screenshot({path:join(evidence,'mobile-recovered-dashboard.png'),fullPage:true});
  check((await context.request.get(base+'/api/config')).status()===200,'recovered browser session failed');
  check(pageErrors.length===0,'browser JavaScript errors: '+pageErrors.join(';'));
  check(consoleErrors.length===0,'unexpected browser console errors: '+consoleErrors.join(';'));
  console.log(JSON.stringify({artifact:native?'native':'formal-dist',browserSetup:true,browserLogin:true,cookieAuth:true,proxyPayload:true,restartSession:true,passwordChange:true,logoutFailurePreserved:true,recoveredLogin:true,desktop:true,mobile:true,health,jsErrors:pageErrors.length,screenshot:join(evidence,'dashboard.png')}));
  passed=true;
} catch (error) {
  console.log('ACCEPTANCE_FAILED evidence='+root);
  // Private logs and databases remain in the fixture directory on failure.
  throw error;
} finally {
  const cleanupErrors: unknown[] = [];
  try { await browser?.close(); } catch(error) { cleanupErrors.push(error); }
  try { if(started) await manager.stop(); } catch(error) { cleanupErrors.push(error); }
  if (child && child.exitCode === null) { try { child.kill('SIGKILL'); await boundedExit(child, 10_000); } catch(error) { cleanupErrors.push(error); } }
  for(const identity of identities.values()){ try { const state=await probeProcessIdentity(identity);check(state==='dead'||state==='mismatch','worker exit not proven'); } catch(error) { cleanupErrors.push(error); } }
  try { await upstream?.stop(true); } catch(error) { cleanupErrors.push(error); }
  for(const port of ports){ try { const server=Bun.serve({hostname:'127.0.0.1',port,reusePort:false,fetch:()=>new Response('closed')});await server.stop(true); } catch(error) { cleanupErrors.push(error); } }
  if(cleanupErrors.length) throw new AggregateError(cleanupErrors,'Storage acceptance cleanup was not proven');
  if(passed) await rm(root,{recursive:true,force:true});
}

}

async function boundedExit(child: ReturnType<typeof Bun.spawn>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = Symbol('timeout');
  try {
    const result = await Promise.race([child.exited, new Promise<typeof timeout>(resolve => { timer = setTimeout(() => resolve(timeout), timeoutMs); })]);
    if (result !== timeout) return result;
    child.kill('SIGKILL');
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([child.exited, new Promise<never>((_, reject) => { killTimer = setTimeout(() => reject(new Error('Owned process did not exit after SIGKILL')), 10_000); })]);
    } finally { clearTimeout(killTimer); }
    throw new Error('Owned process exit timed out; forced exit confirmed');
  } finally { clearTimeout(timer); }
}
