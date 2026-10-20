import { waitUntil } from './gateway-runtime';
import { runRecoveryInTerminal, identityRecoveryAnswers } from './recovery-terminal';
// Run after bun run build. Optional: --binary /absolute/executable
import { chromium, type Request } from 'playwright';
import { captureProcessIdentity, probeProcessIdentity } from '../../packages/core/src/master-runtime/process-identity';
import { waitForAuthPublication } from './auth-publication-readiness';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
export async function runStorageAcceptance(binary?: string) {
const root = await mkdtemp(join(tmpdir(), 'bungee-storage-browser-'));
const native = binary !== undefined;
const password = randomBytes(3).toString('base64url')+'!';
const secrets = [password];
let phase = 'initialization';
const safeUrl = (value: string) => { try { const url = new URL(value); return url.origin + url.pathname; } catch { return value; } };
const redact = (value: string) => secrets.reduce((text, secret) => secret ? text.split(secret).join('[redacted]') : text, value);
const pendingApi = new Map<Request, {phase:string;request:string}>();
const diagnostics: {phase:string;kind:string;url:string;location:{url:string;lineNumber:number;columnNumber:number}|null;message:string}[] = [];
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
const check = (value: unknown, label: string) => { if (!value) throw new Error(redact(label)); };
try {
  for (let i = 0; i < 4; i++) { const server = Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('reserved')}); ports.push(server.port!); await server.stop(true); }
upstream = Bun.serve({hostname:'127.0.0.1',port:0,fetch: async request => Response.json({message:'storage-acceptance',payload:await request.json()})});
  Object.assign(env,{PORT:String(ports[0]),BUNGEE_MANAGEMENT_PORT:String(ports[1]),BUNGEE_MASTER_CONTROL_PORT:String(ports[2]),BUNGEE_INGRESS_SUPERVISION_PORT:String(ports[3])});
  const init = Bun.spawn(native ? [entry,initialization,env.BUNGEE_CONFIG_DB_PATH] : [process.execPath,entry,initialization,env.BUNGEE_CONFIG_DB_PATH],
  {cwd:root,env,stdout:Bun.file(join(root,'init.log')),stderr:Bun.file(join(root,'init-error.log'))});
if (await boundedExit(init, 20_000) !== 0) throw new Error('formal initialization failed: '+root);
  base = `http://127.0.0.1:${ports[1]}`;
  await manager.start({workers:'1'}); started=true;
  await waitUntil(async () => {
    if (child?.exitCode !== null) throw new Error('master exited before setup readiness');
    const response = await fetch(base + '/api/plugins/user-auth/management-setup');
    return response.ok && (await response.json()).initialized === false;
  }, 'management setup did not become ready', 45000);
  await wait();
  const initialMode = await (await fetch(base + '/api/auth/mode')).json();
  check(initialMode.mode === 'anonymous', 'initial management mode was not anonymous');
  browser = await chromium.launch({headless:true});
  const context = await browser.newContext({locale:'zh-CN'});
  await context.addInitScript(() => { if (location.protocol === 'http:' || location.protocol === 'https:') localStorage.setItem('locale','zh-CN'); });
  const page = await context.newPage();
  let expectedLogoutFailures = 0;
  const record = (kind: string, url: string, message: string, location?: {url:string;lineNumber:number;columnNumber:number}) =>
    diagnostics.push({phase, kind, url:safeUrl(url), location:location ? {...location,url:safeUrl(location.url)} : null, message:redact(message)});
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) pendingApi.set(request, {phase,request:`${request.method()} ${safeUrl(request.url())}`});
  });
  page.on('requestfinished', request => {
    pendingApi.delete(request);
  });
  page.on('requestfailed', request => { pendingApi.delete(request); record('requestfailed',request.url(),`${request.method()} ${request.failure()?.errorText}`); });
  page.on('pageerror', error => record('pageerror',page.url(),error.message));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const location = message.location();
    if (expectedLogoutFailures > 0 && safeUrl(location.url) === base + '/api/auth/logout' && message.text().includes('503')) { expectedLogoutFailures--; return; }
    record('console',page.url(),message.text(),location);
  });
  const dashboardAction = async (action: () => Promise<unknown>) => {
    const targetRequest = page.waitForRequest(request => request.method() === 'GET' && new URL(request.url()).pathname === '/api/stats/dashboard', {timeout:20000});
    await action();
    const request = await targetRequest;
    const response = await request.response();
    check(response?.ok(), 'dashboard target request failed: ' + phase);
    check(await response!.finished() === null, 'dashboard response did not finish: ' + phase);
    await page.getByTestId('page-dashboard').waitFor({timeout:20000});
    await page.getByTestId('app-header').waitFor();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    await waitUntil(async () => pendingApi.size === 0,
      'dashboard request did not finish: ' + phase, 20000);
    // Responses have completed; let their consumer continuations and rendering commit.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  };
  await page.route('https://fonts.googleapis.com/**',route=>route.fulfill({contentType:'text/css',body:''}));
  const messages = (await Bun.file(resolve(import.meta.dir,'../../plugins/user-auth/manifest.json')).json()).translations['zh-CN'];
  const activationMessages = (await Bun.file(resolve(import.meta.dir,'../../packages/ui/src/i18n/locales/zh-CN.json')).json()).pluginActivation;
  phase = 'setup';
  await page.goto(base+'/#/plugins');
  const authCard = page.locator('.plugin-management-card').filter({hasText:messages['metadata.name']});
  await authCard.getByRole('switch').click();
  const activationDialog = page.getByRole('dialog');
  await activationDialog.locator('input[autocomplete="username"]').fill(setup.username);
  await activationDialog.locator('input[autocomplete="new-password"]').nth(0).fill(password);
  await activationDialog.locator('input[autocomplete="new-password"]').nth(1).fill(password);
  const [enabled] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === '/api/plugins/user-auth/enable' && response.request().method() === 'POST'),
    activationDialog.locator('button[form="plugin-activation"]').click(),
  ]);
  check(enabled.status()===202,'management enable was not accepted '+enabled.status());
  const accepted = await enabled.json();
  check(Number.isSafeInteger(accepted.revision) && accepted.revision > 0 && typeof accepted.operation_id === 'string', 'management enable did not identify its committed revision');
  let revision: number = accepted.revision;
  await activationDialog.getByRole('button',{name:activationMessages.done,exact:true}).waitFor();
  check((await context.cookies()).some(cookie => cookie.httpOnly),'management enable did not create an HttpOnly cookie');
  const enabledSession = await context.request.get(base+'/api/auth/verify');
  check(enabledSession.ok() && (await enabledSession.json()).success===true,'management enable did not establish a verified cookie session');
  check((await context.request.get(base+'/api/config')).status()===200,'management enable did not authenticate browser configuration access');
  await activationDialog.getByRole('button',{name:activationMessages.done,exact:true}).click();
  await dashboardAction(() => page.getByTestId('app-header').getByRole('link',{name:'BUNGEE',exact:true}).click());
  const signed = await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:setup.username,password,transport:'bearer'})});
  const session = await signed.json(); if (typeof session.token === 'string') secrets.push(session.token); check(signed.ok && session.success,'plugin bearer login failed');
  const bearer = {authorization:'Bearer '+session.token};
  await wait(bearer,revision);
  check((await (await fetch(base+'/api/config',{headers:bearer})).json()).revision===revision,'management enable committed revision differs from configuration');
  check((await fetch(base+'/api/config')).status===401,'anonymous management access was accepted');
  phase = 'cookie-login';
  await page.goto('about:blank');
  await context.clearCookies();
  await page.goto(base+'/#/login');
  await page.locator('input[autocomplete="username"]').fill(setup.username);
  await page.locator('input[autocomplete="current-password"]').fill(password);
  await dashboardAction(() => page.locator('form button').click());
  const browserConfig = await context.request.get(base+'/api/config');
  check(browserConfig.status()===200,'browser cookie session not authenticated '+browserConfig.status()+' '+(browserConfig.ok() ? '' : await browserConfig.text()));
  phase = 'proxy-publication';
  const snapshot = await (await fetch(base+'/api/config',{headers:bearer})).json();
  const serviceId=crypto.randomUUID(), endpointId=crypto.randomUUID(), routeId=crypto.randomUUID();
  const aggregate = {...snapshot.config,logical_configuration:{...snapshot.config.logical_configuration,
    services:[{id:serviceId,position:1,name:'acceptance',plugins:[],endpoints:[{id:endpointId,position:1,target:`http://127.0.0.1:${upstream!.port}`,weight:100,priority:1,is_disabled:false,plugins:[]}]}],
    routes:[{id:routeId,position:1,path:'/acceptance',service_id:serviceId,plugins:[]}]}};
  const saved = await fetch(base+'/api/config',{method:'PUT',headers:{...bearer,'content-type':'application/json'},
    body:JSON.stringify({expected_revision:revision,mutation_id:crypto.randomUUID(),aggregate})});
  check(saved.status===202,'route commit failed '+saved.status+' '+(saved.status===202?'':await saved.text()));
  const routeAccepted = await saved.json();
  check(Number.isSafeInteger(routeAccepted.revision) && routeAccepted.revision > revision,'route commit did not identify its committed revision');
  revision = routeAccepted.revision;
  await wait(bearer,revision);
  const requestBody={marker:crypto.randomUUID(),nested:{value:123}};
  const proxied=await fetch(`http://127.0.0.1:${ports[0]}/acceptance`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(requestBody)});
  const received=await proxied.json(); check(proxied.status===200 && received.message==='storage-acceptance' && JSON.stringify(received.payload)===JSON.stringify(requestBody),'real proxy payload mismatch');
  const health=await (await fetch(base+'/health')).json(); check(health.live && health.management && health.data,'formal health availability mismatch');
  check(diagnostics.length===0,'browser errors: '+JSON.stringify(diagnostics));
  await page.goto('about:blank');
  phase = 'restart';
  await manager.stop(); started=false;
  await manager.start({workers:'1'}); started=true;
  await wait(bearer,revision); await dashboardAction(() => page.goto(base+'/#/'));
  check((await context.request.get(base+'/api/config')).status()===200,'browser session lost after restart');
  check((await fetch(`http://127.0.0.1:${ports[0]}/acceptance`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(requestBody)})).status===200,'proxy failed after restart');
  phase = 'password-revocation';
  const changedPassword=randomBytes(24).toString('base64url'); secrets.push(changedPassword);
  await page.goto(base+'/#/extensions/user-auth/profile');
  const settings=page.getByTestId('auth-user-profile');await settings.waitFor();
  await settings.getByRole('button',{name:messages['profile.changePassword'],exact:true}).click();
  const passwordDialog=page.getByRole('dialog');
  await passwordDialog.getByLabel(messages['settings.currentPassword'],{exact:true}).fill(password);
  await passwordDialog.getByLabel(messages['settings.newPassword'],{exact:true}).fill(changedPassword);
  await passwordDialog.getByLabel(messages['settings.confirmation'],{exact:true}).fill(changedPassword);
  await passwordDialog.getByRole('button',{name:messages['settings.submit'],exact:true}).click();
  await page.waitForURL(base+'/#/login');
  await page.locator('form[aria-busy="false"] button:not([type="button"]):enabled').waitFor();
  check((await fetch(base+'/api/auth/verify',{headers:bearer})).status===401,'password change retained the old Bearer');
  await page.locator('input[autocomplete="username"]').fill(setup.username);
  await page.locator('input[autocomplete="current-password"]').fill(changedPassword);
  await dashboardAction(() => page.locator('form button').click());
  await page.goto(base+'/#/extensions/user-auth/profile');await settings.waitFor();
  phase = 'logout-failure';
  expectedLogoutFailures=1;
  await page.route('**/api/auth/logout',route=>{ check(route.request().method()==='POST','unexpected logout method'); return route.fulfill({status:503,json:{error:'provider_unavailable'}}); });
  await waitUntil(async () => pendingApi.size === 0, 'profile API requests did not finish: ' + phase, 20000);
  await settings.getByRole('button',{name:messages['settings.logout'],exact:true}).click();
  await settings.getByRole('alert').waitFor();
  check((await context.request.get(base+'/api/config')).status()===200,'failed logout cleared the valid session');
  await page.unroute('**/api/auth/logout');
  check(expectedLogoutFailures === 0,'expected logout failure was not observed');
  phase = 'logout-success';
  await waitUntil(async () => pendingApi.size === 0, 'profile API requests did not finish: ' + phase, 20000);
  await settings.getByRole('button',{name:messages['settings.logout'],exact:true}).click();
  await page.waitForURL(base+'/#/login');
  await page.locator('form[aria-busy="false"] button:not([type="button"]):enabled').waitFor();
  check((await context.request.get(base+'/api/config')).status()===401,'successful logout retained session');
  await waitUntil(async () => pendingApi.size === 0, 'login API requests did not finish: ' + phase, 20000);
  await page.goto('about:blank');
  await manager.stop();started=false;
  phase = 'offline-recovery';
  const recoveredPassword=randomBytes(24).toString('base64url'); secrets.push(recoveredPassword);
  const args=['--recover',env.BUNGEE_CONFIG_DB_PATH,'--plugin','user-auth','--action','reset'];
  const recovery=await runRecoveryInTerminal(native?[entry,...args]:[process.execPath,entry,...args],
    {cwd:root,env},identityRecoveryAnswers('recovered-owner',recoveredPassword,'Browser recovery acceptance'));
  check(recovery.code===0,'local account recovery failed');
  check(!recovery.output.includes(recoveredPassword),'recovery leaked password');
  await manager.start({workers:'1'});started=true;
  await waitUntil(async()=>{try{return (await fetch(base+'/api/auth/mode')).ok;}catch{return false;}},'restored instance unavailable',45000);
  await page.goto(base+'/#/login');
  await page.locator('input[autocomplete="username"]').fill('recovered-owner');
  await page.locator('input[autocomplete="current-password"]').fill(recoveredPassword);
  await dashboardAction(() => page.locator('form button').click());
  await dashboardAction(() => page.reload());
  check((await context.request.get(base+'/api/config')).status()===200,'recovered browser session failed');
  check(diagnostics.length===0,'browser errors: '+JSON.stringify(diagnostics));
  console.log(JSON.stringify({artifact:native?'native':'formal-dist',browserSetup:true,browserLogin:true,cookieAuth:true,proxyPayload:true,restartSession:true,passwordChange:true,logoutFailurePreserved:true,recoveredLogin:true,health,jsErrors:diagnostics.length}));
  passed=true;
} catch (error) {
  console.log(JSON.stringify({acceptance:'failed',phase,root,diagnostics,pendingApi:[...pendingApi.values()]}));
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
