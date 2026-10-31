import { waitUntil, reservePortBlock, releasePortBlock, type PortLease } from './gateway-runtime';
import { runRecoveryInTerminal, identityRecoveryAnswers } from './recovery-terminal';
// Run after bun run build. Optional: --binary /absolute/executable
import { chromium, type Page, type Request } from 'playwright';
import { captureProcessIdentity, probeProcessIdentity } from '../../packages/core/src/master-runtime/process-identity';
import { waitForAuthPublication } from './auth-publication-readiness';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
const RUNTIME_READ_PATH = '/api/config/runtime';
type PendingApi = {phase:string;request:string;sequence:number;startedAt:number};
type DeferredFailure = {pending:PendingApi;errorText:string;failedAt:number};
type Replacement = {kind:string;candidates:Set<Request>;failures:Map<Request,DeferredFailure>};
type RetiredReads = {kind:string;succeeded:boolean;requests:Map<Request,PendingApi>};
type PageSession = {id:number;page:Page;pending:ReadonlyMap<Request,PendingApi>;close:()=>Promise<void>;reloadWithReaderGate:()=>Promise<void>};
// A read is only exempted when the test replaced the page that opened it and the
// browser reports that same request as aborted by the replacement.
const expectedDocumentCancellation = (facts: {snapshotted:boolean;replacementSucceeded:boolean;method:string;resourceType:string;sameOrigin:boolean;pathname:string;errorText:string}) =>
  facts.snapshotted && facts.replacementSucceeded && facts.method==='GET' && facts.resourceType==='fetch'
  && facts.sameOrigin && facts.pathname===RUNTIME_READ_PATH && facts.errorText==='net::ERR_ABORTED';
const pageDestroyedError = (error: unknown) => /Target page, context or browser has been closed|Execution context was destroyed|Request context disposed|Target closed/i.test(String(error));

export async function runStorageAcceptance(binary?: string) {
const root = await mkdtemp(join(tmpdir(), 'bungee-storage-browser-'));
const native = binary !== undefined;
const password = randomBytes(3).toString('base64url')+'!';
const secrets = [password];
let phase = 'initialization';
const safeUrl = (value: string) => { try { const url = new URL(value); return url.origin + url.pathname; } catch { return value; } };
const redact = (value: string) => secrets.reduce((text, secret) => secret ? text.split(secret).join('[redacted]') : text, value);
const setup = {username:'acceptance-owner',password,passwordConfirmation:password};
const entry = native ? resolve(binary!) : resolve(import.meta.dir, '../../packages/core/dist/main.js');
let upstream: ReturnType<typeof Bun.serve> | undefined;
let lease: PortLease | undefined;
const env = {...process.env, BUNGEE_CONFIG_DB_PATH:join(root,'bungee.db'), BUNGEE_ACCESS_DB_PATH:join(root,'access.db'),
  BUNGEE_BODY_LOG_DIR:join(root,'bodies'), BUNGEE_HEADER_LOG_DIR:join(root,'headers'), BUNGEE_FILE_LOG_DIR:join(root,'files'), DATA_DIR:root,
  BUNGEE_PLUGIN_SECRETS_KEY:randomBytes(32).toString('base64'), BUNGEE_INCLUDE_SYSTEM_PLUGINS:'false',
  PLUGINS_DIR:resolve(import.meta.dir, '../../packages/core/dist/plugins'), HOST:'127.0.0.1', BUNGEE_MANAGEMENT_HOST:'127.0.0.1', WORKER_COUNT:'1'};
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
let started = false;
let failure: unknown, summary: Record<string, unknown> | undefined;
const wait = async (headers: HeadersInit={},revision?:number) => {
  const runtime = await waitForAuthPublication({base,headers,revision,timeoutMs:45000,childExited:()=>child?.exitCode!==null,childDiagnostic:()=>({root,exit:child?.exitCode})});
  for (const worker of runtime.workers) if (!identities.has(worker.worker_instance_id)) identities.set(worker.worker_instance_id,await captureProcessIdentity(worker.pid,worker.worker_instance_id));
  return runtime;
};
const check = (value: unknown, label: string) => { if (!value) throw new Error(redact(label)); };
// Aggregates stay outside the try so the failure report can always read them.
const diagnostics: {phase:string;kind:string;url:string;location:{url:string;lineNumber:number;columnNumber:number}|null;message:string;request?:PendingApi&{failedAt:number}}[] = [];
const expectedCancellations: {kind:string;phase:string;request:string;sequence:number;startedAt:number;failedAt:number;error:string}[] = [];
const pageViews: {id:number;pending:ReadonlyMap<Request,PendingApi>}[] = [];
let readerEvidence: {kind:string;observed?:string;classified:boolean} | undefined;
const assertCancellationClassifier = () => {
  const supported = {snapshotted:true,replacementSucceeded:true,method:'GET',resourceType:'fetch',sameOrigin:true,
    pathname:RUNTIME_READ_PATH,errorText:'net::ERR_ABORTED'};
  check(expectedDocumentCancellation(supported), 'cancellation classifier rejected the expected cancellation shape');
  const rejected: [string, Partial<typeof supported>][] = [
    ['a write request', {method:'POST'}], ['another endpoint', {pathname:'/api/config'}],
    ['another origin', {sameOrigin:false}], ['another failure', {errorText:'net::ERR_FAILED'}],
    ['a non-fetch request', {resourceType:'document'}], ['an unsuccessful close or reload', {replacementSucceeded:false}],
    ['a request outside the snapshot', {snapshotted:false}],
  ];
  for (const [label, patch] of rejected) check(!expectedDocumentCancellation({...supported,...patch}), 'cancellation classifier accepted '+label);
};
try {
  assertCancellationClassifier();
  upstream = Bun.serve({hostname:'127.0.0.1',port:0,fetch: async request => Response.json({message:'storage-acceptance',payload:await request.json()})});
  lease = await reservePortBlock();
  const [proxyPort, managementPort, masterControlPort, supervisionPort] = lease.block.ports;
  Object.assign(env,{PORT:String(proxyPort),BUNGEE_MANAGEMENT_PORT:String(managementPort),BUNGEE_MASTER_CONTROL_PORT:String(masterControlPort),BUNGEE_INGRESS_SUPERVISION_PORT:String(supervisionPort)});
  const init = Bun.spawn(native ? [entry,initialization,env.BUNGEE_CONFIG_DB_PATH] : [process.execPath,entry,initialization,env.BUNGEE_CONFIG_DB_PATH],
  {cwd:root,env,stdout:Bun.file(join(root,'init.log')),stderr:Bun.file(join(root,'init-error.log'))});
if (await boundedExit(init, 20_000) !== 0) throw new Error('formal initialization failed: '+root);
  base = `http://127.0.0.1:${managementPort}`;
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
  let expectedLogoutFailures = 0, requestSequence = 0;
  const record = (kind: string, url: string, message: string, location?: {url:string;lineNumber:number;columnNumber:number}, request?: PendingApi) =>
    diagnostics.push({phase, kind, url:safeUrl(url), location:location ? {...location,url:safeUrl(location.url)} : null, message:redact(message),
      ...(request ? {request:{...request,failedAt:performance.now()}} : {})});
  // Each page owns its request bookkeeping; callbacks never share another page's state.
  const openPage = async () => {
    const ownedPage = await context.newPage();
    const pending = new Map<Request, PendingApi>();
    let active: Replacement | undefined;
    let retired: RetiredReads | undefined;
    const origin = () => new URL(base).origin;
    const isRuntimeRead = (request: Request) => {
      const url = new URL(request.url());
      return request.method()==='GET' && request.resourceType()==='fetch' && url.origin===origin() && url.pathname===RUNTIME_READ_PATH;
    };
    const settle = (request: Request, meta: PendingApi, errorText: string, succeeded: boolean, kind: string) => {
      const url = new URL(request.url());
      if (expectedDocumentCancellation({snapshotted:true,replacementSucceeded:succeeded,method:request.method(),
        resourceType:request.resourceType(),sameOrigin:url.origin===origin(),pathname:url.pathname,errorText})) {
        expectedCancellations.push({kind,phase:meta.phase,request:meta.request,sequence:meta.sequence,
          startedAt:meta.startedAt,failedAt:performance.now(),error:errorText});
      } else {
        record('requestfailed',request.url(),`${request.method()} ${errorText}`,undefined,meta);
      }
    };
    const beginReplacement = (kind: string) => {
      active = {kind,candidates:new Set([...pending.keys()].filter(isRuntimeRead)),failures:new Map()};
    };
    const finishReplacement = (succeeded: boolean) => {
      const operation = active; active = undefined;
      if (!operation) return;
      for (const [request, deferred] of operation.failures) settle(request,deferred.pending,deferred.errorText,succeeded,operation.kind);
      operation.failures.clear();
    };
    ownedPage.on('request', request => {
      const url = new URL(request.url());
      if (url.pathname.startsWith('/api/')) pending.set(request, {phase,request:`${request.method()} ${safeUrl(request.url())}`,sequence:++requestSequence,startedAt:performance.now()});
    });
    ownedPage.on('requestfinished', request => {
      pending.delete(request);
      active?.candidates.delete(request);
      retired?.requests.delete(request);
    });
    ownedPage.on('requestfailed', request => {
      const meta = pending.get(request) ?? retired?.requests.get(request);
      const errorText = request.failure()?.errorText ?? '';
      pending.delete(request);
      if (meta && active?.candidates.has(request)) {
        active.candidates.delete(request);
        active.failures.set(request,{pending:meta,errorText,failedAt:performance.now()});
        return;
      }
      if (meta && retired?.requests.has(request)) {
        retired.requests.delete(request);
        settle(request,meta,errorText,retired.succeeded,retired.kind);
        return;
      }
      record('requestfailed',request.url(),`${request.method()} ${errorText}`,undefined,meta);
    });
    ownedPage.on('pageerror', error => record('pageerror',ownedPage.url(),error.message));
    ownedPage.on('console', message => {
      if (message.type() !== 'error') return;
      const location = message.location();
      if (expectedLogoutFailures > 0 && safeUrl(location.url) === base + '/api/auth/logout' && message.text().includes('503')) { expectedLogoutFailures--; return; }
      record('console',ownedPage.url(),message.text(),location);
    });
    await ownedPage.route('https://fonts.googleapis.com/**',route=>route.fulfill({contentType:'text/css',body:''}));
    const close = async () => {
      await waitUntil(() => [...pending.keys()].every(isRuntimeRead), 'page requests did not finish before close: ' + phase, 20000);
      beginReplacement('page-close');
      await ownedPage.close().catch(error => { finishReplacement(false); throw error; });
      const snapshot = active?.candidates ?? new Set<Request>();
      finishReplacement(true);
      retired = {kind:'page-close',succeeded:true,requests:new Map()};
      for (const [request, meta] of [...pending]) {
        if (isRuntimeRead(request) && snapshot.has(request)) retired.requests.set(request,meta);
        // Any other read left after close is unknown or a write path: it must fail, not be dropped.
        else record('requestpending',request.url(),`${request.method()} still pending after page close`,undefined,meta);
        pending.delete(request);
      }
    };
    const reloadWithReaderGate = async () => {
      const reader = crypto.randomUUID();
      const isReader = (url: URL) => url.origin===origin() && url.pathname===RUNTIME_READ_PATH && url.searchParams.get('reader')===reader;
      let releaseGate!: () => void;
      // Releasing the gate in the reload's own finally lets the handler finish after the navigation.
      const gate = new Promise<void>(resolve => { releaseGate = resolve; });
      let upstreamOk = false, handlerDone = false, handlerError: unknown;
      await ownedPage.route(isReader, async route => {
        try {
          const response = await route.fetch();
          upstreamOk = response.ok();
          await gate;
          // The reload may already have cancelled this read; end on that real terminal
          // state instead of feeding a dead route and depending on error text.
          if (route.request().failure() !== null) return;
          await route.fulfill({response});
        } catch (error) { handlerError = error; }
        finally { handlerDone = true; }
      });
      try {
        const arrival = ownedPage.waitForRequest(request => isReader(new URL(request.url())), {timeout:20000});
        await ownedPage.evaluate(token => { void fetch('/api/config/runtime?reader='+encodeURIComponent(token),{cache:'no-store'}).catch(() => {}); }, reader);
        const request = await arrival;
        await waitUntil(() => upstreamOk || handlerError !== undefined, 'controlled runtime reader did not reach the real runtime endpoint', 20000);
        check(upstreamOk, 'controlled runtime reader upstream was not ok: '+redact(String(handlerError ?? '')));
        const meta = pending.get(request);
        check(meta !== undefined, 'controlled runtime reader was not pending before the reload');
        const classified = expectedCancellations.length, recorded = diagnostics.length;
        readerEvidence = {kind:'page-reload',classified:false};
        beginReplacement('page-reload');
        let response: Awaited<ReturnType<Page['reload']>>;
        try { response = await ownedPage.reload(); } catch (error) { finishReplacement(false); throw error; } finally { releaseGate(); }
        const committed = response !== null && response.request().isNavigationRequest() && response.frame() === ownedPage.mainFrame();
        if (!committed) { finishReplacement(false); check(false, 'reload did not commit a main-frame document: ' + phase); }
        try {
          await waitUntil(() => active === undefined || active.candidates.size === 0, 'replaced document reads did not settle: ' + phase, 20000);
        } catch (error) { finishReplacement(false); throw error; }
        readerEvidence.observed = active?.failures.get(request)?.errorText;
        try {
          await waitUntil(() => handlerDone, 'controlled runtime reader route handler did not settle', 20000);
        } catch (error) { finishReplacement(false); throw error; }
        if (handlerError !== undefined) check(pageDestroyedError(handlerError) && active?.failures.get(request)?.errorText === 'net::ERR_ABORTED',
          'controlled runtime reader route handler failed unexpectedly: '+redact(String(handlerError)));
        finishReplacement(true);
        const cancellation = expectedCancellations.slice(classified).find(entry => entry.sequence === meta!.sequence);
        check(cancellation !== undefined, 'controlled runtime reader cancellation was not classified as page reload');
        readerEvidence.classified = true;
        check(diagnostics.length === recorded, 'controlled runtime reader cancellation leaked into diagnostics');
        check(cancellation!.kind === 'page-reload' && cancellation!.request === `GET ${safeUrl(base + RUNTIME_READ_PATH)}` && cancellation!.error === 'net::ERR_ABORTED',
          'controlled runtime reader cancellation evidence did not match the reloaded page');
      } finally {
        releaseGate();
        await ownedPage.unroute(isReader);
      }
    };
    const session: PageSession = {id:pageViews.length,page:ownedPage,pending,close,reloadWithReaderGate};
    pageViews.push({id:session.id,pending});
    return session;
  };
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
    await waitUntil(async () => current.pending.size === 0,
      'dashboard request did not finish: ' + phase, 20000);
    // Responses have completed; let their consumer continuations and rendering commit.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  };
  const messages = (await Bun.file(resolve(import.meta.dir,'../../plugins/user-auth/manifest.json')).json()).translations['zh-CN'];
  const activationMessages = (await Bun.file(resolve(import.meta.dir,'../../packages/ui/src/i18n/locales/zh-CN.json')).json()).pluginActivation;
  let current = await openPage();
  let page = current.page;
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
  const signedIn = await signed.json(); if (typeof signedIn.token === 'string') secrets.push(signedIn.token); check(signed.ok && signedIn.success,'plugin bearer login failed');
  const bearer = {authorization:'Bearer '+signedIn.token};
  await wait(bearer,revision);
  check((await (await fetch(base+'/api/config',{headers:bearer})).json()).revision===revision,'management enable committed revision differs from configuration');
  check((await fetch(base+'/api/config')).status===401,'anonymous management access was accepted');
  phase = 'cookie-login';
  await current.close();
  await context.clearCookies();
  current = await openPage(); page = current.page;
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
    routes:[{id:routeId,position:1,path:'/acceptance',service_references: [{ id: crypto.randomUUID(), position: 0, service_id: serviceId, weight: 100, priority: 1, is_disabled: false }],plugins:[]}]}};
  const saved = await fetch(base+'/api/config',{method:'PUT',headers:{...bearer,'content-type':'application/json'},
    body:JSON.stringify({expected_revision:revision,mutation_id:crypto.randomUUID(),aggregate})});
  check(saved.status===202,'route commit failed '+saved.status+' '+(saved.status===202?'':await saved.text()));
  const routeAccepted = await saved.json();
  check(Number.isSafeInteger(routeAccepted.revision) && routeAccepted.revision > revision,'route commit did not identify its committed revision');
  revision = routeAccepted.revision;
  await wait(bearer,revision);
  const requestBody={marker:crypto.randomUUID(),nested:{value:123}};
  const proxied=await fetch(`http://127.0.0.1:${proxyPort}/acceptance`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(requestBody)});
  const received=await proxied.json(); check(proxied.status===200 && received.message==='storage-acceptance' && JSON.stringify(received.payload)===JSON.stringify(requestBody),'real proxy payload mismatch');
  const health=await (await fetch(base+'/health')).json(); check(health.live && health.management && health.data,'formal health availability mismatch');
  check(diagnostics.length===0,'browser errors: '+JSON.stringify(diagnostics));
  await current.close();
  phase = 'restart';
  await manager.stop(); started=false;
  await manager.start({workers:'1'}); started=true;
  await wait(bearer,revision); current = await openPage(); page = current.page; await dashboardAction(() => page.goto(base+'/#/'));
  check((await context.request.get(base+'/api/config')).status()===200,'browser session lost after restart');
  check((await fetch(`http://127.0.0.1:${proxyPort}/acceptance`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(requestBody)})).status===200,'proxy failed after restart');
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
  await waitUntil(async () => current.pending.size === 0, 'profile API requests did not finish: ' + phase, 20000);
  await settings.getByRole('button',{name:messages['settings.logout'],exact:true}).click();
  await settings.getByRole('alert').waitFor();
  check((await context.request.get(base+'/api/config')).status()===200,'failed logout cleared the valid session');
  await page.unroute('**/api/auth/logout');
  check(expectedLogoutFailures === 0,'expected logout failure was not observed');
  phase = 'logout-success';
  await waitUntil(async () => current.pending.size === 0, 'profile API requests did not finish: ' + phase, 20000);
  await settings.getByRole('button',{name:messages['settings.logout'],exact:true}).click();
  await page.waitForURL(base+'/#/login');
  await page.locator('form[aria-busy="false"] button:not([type="button"]):enabled').waitFor();
  check((await context.request.get(base+'/api/config')).status()===401,'successful logout retained session');
  await waitUntil(async () => current.pending.size === 0, 'login API requests did not finish: ' + phase, 20000);
  await current.close();
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
  current = await openPage(); page = current.page;
  await page.goto(base+'/#/login');
  await page.locator('input[autocomplete="username"]').fill('recovered-owner');
  await page.locator('input[autocomplete="current-password"]').fill(recoveredPassword);
  await dashboardAction(() => page.locator('form button').click());
  await dashboardAction(() => current.reloadWithReaderGate());
  check((await context.request.get(base+'/api/config')).status()===200,'recovered browser session failed');
  await current.close();
  summary = {artifact:native?'native':'formal-dist',browserSetup:true,browserLogin:true,cookieAuth:true,proxyPayload:true,restartSession:true,passwordChange:true,logoutFailurePreserved:true,recoveredLogin:true,health};
} catch (error) {
  failure = error;
  console.log(JSON.stringify({acceptance:'failed',phase,root,diagnostics,pages:pageViews.map(view => ({page:view.id,pending:[...view.pending.values()]})),expectedCancellations,readerEvidence}));
  // Private logs and databases remain in the fixture directory on failure.
} finally {
  const cleanupErrors: unknown[] = [];
  try { await browser?.close(); } catch(error) { cleanupErrors.push(error); }
  // Page listeners stay attached until the browser closes; only now can no further
  // page events arrive, so the final strict diagnostics assertion runs here.
  if (failure === undefined) {
    try {
      check(diagnostics.length===0,'browser errors: '+JSON.stringify(diagnostics));
      console.log(JSON.stringify({...summary,jsErrors:diagnostics.length,expectedCancellations,readerEvidence}));
    } catch (error) {
      failure = error;
      console.log(JSON.stringify({acceptance:'failed',phase,root,diagnostics,pages:pageViews.map(view => ({page:view.id,pending:[...view.pending.values()]})),expectedCancellations,readerEvidence}));
    }
  }
  try { if(started) await manager.stop(); } catch(error) { cleanupErrors.push(error); }
  if (child && child.exitCode === null) { try { child.kill('SIGKILL'); await boundedExit(child, 10_000); } catch(error) { cleanupErrors.push(error); } }
  for(const identity of identities.values()){ try { const state=await probeProcessIdentity(identity);check(state==='dead'||state==='mismatch','worker exit not proven'); } catch(error) { cleanupErrors.push(error); } }
  try { await upstream?.stop(true); } catch(error) { cleanupErrors.push(error); }
  if (lease) { try { await releasePortBlock(lease); } catch(error) { cleanupErrors.push(error); } }
  if (cleanupErrors.length) throw failure === undefined
    ? new AggregateError(cleanupErrors,'Storage acceptance cleanup was not proven')
    : new AggregateError([failure,...cleanupErrors],'Storage acceptance failed and cleanup was not proven');
  if (failure === undefined) await rm(root,{recursive:true,force:true});
}
if (failure !== undefined) throw failure;

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
