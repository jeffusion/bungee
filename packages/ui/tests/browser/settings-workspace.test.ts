import { systemUpdateStatusFixture } from '../helpers/system-updates';
import { afterAll, beforeAll, test } from 'bun:test';
import { chromium, expect, type Browser, type Page } from 'playwright/test';
import type { ConfigurationAggregate } from '@jeffusion/bungee-types';
import type { ConfigurationOperationState, ConfigurationPublication } from '../../src/api/config';
import { startUiRuntime } from '../../../../tests/helpers/ui-runtime';
import { configurationRuntimeFixture, publicationFixture } from '../helpers/publication';
import { collectApiEvidence } from '../helpers/editors/api-evidence';
import { recordResponseDelivery, holdResponseJson, waitForResponseReceipt, releaseResponseJson, waitForResponseDelivery } from '../helpers/editors/response-delivery';
import { menuSnapshot, fulfillMenuIcons, requestLogsPlugin, requestLogsMenuPage } from '../helpers/menus';

let runtime: Awaited<ReturnType<typeof startUiRuntime>>, browser: Browser;
beforeAll(async () => {
  runtime = await startUiRuntime({ mode: 'built-page' });
  try { browser = await chromium.launch(); } catch (error) { await runtime.close(); throw error; }
}, 120_000);
afterAll(async () => { try { await browser?.close(); } finally { await runtime?.close(); } });
const aggregate = (): ConfigurationAggregate => ({ logical_configuration: { websocket_max_message_bytes: 50 * 1024 * 1024, log_level: 'info', routes: [], services: [], plugins: [],
  logging: { body: { enabled: true, max_size: 51200, retention_days: 1 } } }, plugin_activations: [] });
const digest = `sha256:${'a'.repeat(64)}` as const;
const envelope = (value: ConfigurationAggregate) => ({format:'bungee-config-snapshot',format_version:1,schema_version:1,
  exported_at:1,source_revision:42,content_hash:digest,envelope_hash:digest,aggregate:value});
function operation(id: string, state: 'converged' | 'committed' | 'draining' | 'degraded' = 'converged', expectedRevision = 42): ConfigurationOperationState {
  return { operation: { mutation_id:id, request_hash:digest, expected_revision:expectedRevision, committed_revision:expectedRevision + 1, kind:'config',
    target_worker_count:2,drain_recovery_generation:0,last_drain_recovery_previous_generation:null,created_at:1,updated_at:1,
    state, result_status:state === 'converged' ? 200 : null,error_code:null,error_detail:null } as ConfigurationOperationState['operation'], workers:[] };
}
async function withSettings(run: (page: Page, model: ReturnType<typeof createModel>) => Promise<void>, width=1440, language='en', route='config', configureModel?: (model: ReturnType<typeof createModel>) => void) {
  const context = await browser.newContext({viewport:{width,height:900}});
  const model=createModel();
  try {
  configureModel?.(model);
  const page=await context.newPage();
  const evidence=collectApiEvidence(page),errors=evidence.errors;
  await recordResponseDelivery(page,'/api/config/validate');
  await recordResponseDelivery(page,'/api/config');
  await recordResponseDelivery(page,'/api/config/runtime');
  await page.route('https://fonts.googleapis.com/**',route=>route.fulfill({contentType:'text/css',body:''}));
  await page.addInitScript(language=>localStorage.setItem('locale',language),language);
  await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/,async route=>{
    const request=route.request(), path=new URL(request.url()).pathname, method=request.method();
    const json=(value:unknown,status=200)=>{if(status>=400)evidence.expectStatus(route,status);return route.fulfill({json:value,status});};
    const allowedWrite = method === 'PUT' && path === '/api/config' || method === 'POST' && ['/api/config/import','/api/config/validate','/api/logs/cleanup'].includes(path);
    if(method !== 'GET' && !allowedWrite) {errors.push(`Unexpected ${method} ${path}`);return json({error:'unexpected_method'},500);}
    if(path === '/api/auth/mode') return json({mode:'anonymous',publicOrigin:runtime.origin});
    if(path === '/api/auth/verify') return json({success:true,mode:'anonymous',subject:{id:'anonymous',provider:'anonymous'}});
    if (route.request().method() === 'GET' && new URL(route.request().url()).pathname === '/api/system/updates') return route.fulfill({ json: systemUpdateStatusFixture });
    if(path === '/api/ui/menus') return json(menuSnapshot(route === 'config' ? [] : [
      { ...requestLogsMenuPage, available: model.logsEnabled },
    ]));
    if(path === '/api/ui/icons/data') return fulfillMenuIcons(route);
    if(path === '/api/plugins') return json(route === 'config' ? [] : [{ ...requestLogsPlugin, enabled: model.logsEnabled }]);
    if(path === '/api/plugin-translations') return json({});
    if(path === '/api/resources/api-key') return json({keys:[]});
    if(path === '/api/config/runtime') return model.runtimeUnavailable ? json({error:'runtime_unavailable'},503) : json({
      ...configurationRuntimeFixture(model.publication ?? publicationFixture({operation:null,recovery:null,retryable:false,serving_complete:true,
        serving_revision:model.revision,target_revision:model.revision})),config:model.saved});
    if(path === '/api/config' && method === 'GET') {
      const gate=model.configGate;
      if(gate){model.configGate=null;model.configGateEntered?.();await gate;}
      return json({revision:model.revision,content_hash:digest,config:model.saved});
    }
    if(path === '/api/logs') return json({data:[],total:0,totalPages:0,page:1,limit:50});
    if(path === '/api/logs/cleanup/config') return model.cleanupRefreshFailure && model.cleanupWrites ? json({error:'offline'},503) : json({enabled:true,retentionDays:1,scheduleIntervalHours:1,isActive:true});
    if(path === '/api/logs/cleanup' && method === 'POST') {model.cleanupWrites++;return model.cleanupStatus ? json({error:'rejected'},model.cleanupStatus) : json({success:true});}
    if(path === '/api/config/export' && method === 'GET') {model.exports++;return json(envelope(model.saved));}
    if(path === '/api/config/validate' && method === 'POST') {
      const body=request.postDataJSON(); model.validations.push(body);
      return body.envelope ? json({valid:true,errors:[],aggregate:body.envelope.aggregate}) : json({valid:true,errors:[]});
    }
    if(path === '/api/config' && method === 'PUT' || path === '/api/config/import' && method === 'POST') {
      const body=request.postDataJSON(); model.writes.push({method,path,body}); model.id=body.mutation_id;
      if(model.rejection) return json({error:model.rejection,reason:'lease_margin',message:'PRIVATE-ERROR',aggregate:{secret:'PRIVATE-ERROR'}},model.status);
      if(model.networkFailure) {evidence.expectFailure(request,'net::ERR_CONNECTION_RESET');return route.abort('connectionreset');}
      if(model.nonJson) {evidence.expectStatus(route,503);return route.fulfill({status:503,contentType:'text/plain',body:'PRIVATE-ERROR'});}
      model.saved=body.aggregate ?? body.envelope.aggregate;model.expected=body.expected_revision;model.revision=body.expected_revision+1;
      return json({...operation(model.id,model.active?'committed':'converged',body.expected_revision),operation_id:model.id,revision:model.revision},202);
    }
    if(path === `/api/config/operations/${model.id}` && method === 'GET') {model.queries++;const gate=model.operationGate;if(gate){model.operationGate=null;await gate;}return model.queryStatus ? json({error:'unavailable'},model.queryStatus) : json(operation(model.id,model.queryState,model.expected));}
    errors.push(`Unexpected API ${method} ${path}`);return json({error:'unexpected_request'},500);
  });
    await page.goto(`${runtime.origin}/#/${route}`);
    if (route === 'config') {
      if (configureModel) await expect(page.getByRole('combobox',{name:/^(Log Level|日志级别)$/})).toBeEnabled();
      else {
        await expect(page.locator('#config-websocket-max-message')).toHaveValue('50');
        await expect(page.getByRole('combobox',{name:/^(Log Level|日志级别)$/})).toBeEnabled();
      }
    } else await expect(page.getByTestId('request-logs-save')).toBeVisible();
    await run(page,model);expect(errors).toEqual([]);evidence.verify();
  } finally { await context.close(); }
}
function createModel() {
  return {saved:aggregate(),revision:42,expected:42,id:'',writes:[] as Array<{method:string;path:string;body:any}>,validations:[] as any[],exports:0,
    active:false,queryState:'converged' as 'converged'|'draining'|'degraded',publication:null as ConfigurationPublication|null,
    cleanupWrites:0,cleanupStatus:0,cleanupRefreshFailure:false,queries:0,rejection:'',status:503,networkFailure:false,nonJson:false,queryStatus:0,runtimeUnavailable:false,logsEnabled:true,
    operationGate:null as Promise<void>|null,
    configGate:null as Promise<void>|null,configGateEntered:null as (()=>void)|null,
};
}
async function review(page:Page) {
  await page.getByTestId('config-save-button').click();
  await expect(page.getByTestId('config-confirm-publish')).toBeEnabled();
}
async function closeReview(page:Page) {
  const review=page.getByTestId('config-review');
  // An unconfirmed submission closes the review itself; known rejections stay open for correction.
  if (await review.count() === 0) return;
  await review.waitFor({state:'detached',timeout:1500}).catch(()=>{});
  if (await review.count() === 0) return;
  await page.getByRole('dialog').getByRole('button',{name:/Close review|关闭检查/,exact:true}).click();
  await expect(review).toHaveCount(0);
}
async function upload(page:Page,value:unknown) {
  await page.getByTestId('config-import-input').setInputFiles({name:'snapshot.json',mimeType:'application/json',buffer:Buffer.from(typeof value==='string'?value:JSON.stringify(value))});
}
async function waitForSettingsReads(page:Page) {
  // A terminal operation can precede both its snapshot and follow-up runtime read.
  for (const path of ['/api/config','/api/config/runtime']) {
    const requestId: number | undefined = await page.evaluate(path => (window as any).editorResponseDelivery.requests
      .findLast((entry: { method: string; url: string }) => entry.method === 'GET' && new URL(entry.url).pathname === path)?.id, path);
    if (requestId === undefined) throw new Error(`Missing ${path} settings read`);
    await waitForResponseDelivery(page,requestId);
  }
}
async function reloadSettings(page:Page) {
  await waitForSettingsReads(page);
  await page.reload();
}

test('review, cancellation, publication and export preserve the current draft and use snapshot CAS',async()=>{
  await withSettings(async(page,model)=>{
    await page.locator('#config-websocket-max-message').fill('52');await review(page);
    await closeReview(page);await expect(page.locator('#config-websocket-max-message')).toHaveValue('52');expect(model.writes).toHaveLength(0);
    await review(page);await page.getByTestId('config-confirm-publish').click();
    await expect(page.getByTestId('config-review')).toHaveCount(0);
    expect(model.writes).toHaveLength(1);expect(model.writes[0]!.body.expected_revision).toBe(42);
    expect(model.writes[0]!.body.aggregate.logical_configuration.websocket_max_message_bytes).toBe(52 * 1024 * 1024);
    await page.getByRole('button',{name:'Configuration actions',exact:true}).click();
    await page.getByRole('menuitem',{name:'Export configuration',exact:true}).click();
    await page.getByTestId('confirmation-cancel').click();expect(model.exports).toBe(0);
    await page.getByRole('button',{name:'Configuration actions',exact:true}).click();
    await page.getByRole('menuitem',{name:'Export configuration',exact:true}).click();
    const downloaded=page.waitForEvent('download');await page.getByTestId('confirmation-accept').click();await downloaded;expect(model.exports).toBe(1);
  });
},60_000);

test('a config loaded without logging stays without logging when publishing an unrelated edit',async()=>{
  await withSettings(async(page,model)=>{
    await expect(page.getByTestId('logging-max-size')).toHaveCount(0);
    await page.locator('#config-websocket-max-connections').focus();
    // Blurring an untouched numeric field must not materialize its displayed default.
    for (const field of ['drain_start_timeout_ms','drain_timeout_ms','worker_exit_timeout_ms']) await page.locator(`#config-${field}`).focus();
    await page.getByRole('combobox',{name:/^(Log Level|日志级别)$/}).click();
    await page.getByRole('option',{name:'Debug',exact:true}).click();
    await review(page);
    expect(Object.hasOwn(model.validations.at(-1).aggregate.logical_configuration,'publication')).toBe(false);
    await page.getByTestId('config-confirm-publish').click();
    await expect(page.getByTestId('config-review')).toHaveCount(0);
    expect(model.writes).toHaveLength(1);
    const saved=model.writes[0]!.body.aggregate.logical_configuration;
    expect(saved.log_level).toBe('debug');
    expect(Object.hasOwn(saved,'logging')).toBe(false);
    expect(Object.hasOwn(saved,'websocket_max_connections')).toBe(false);
    expect(Object.hasOwn(saved,'publication')).toBe(false);
  },1440,'en','config',model=>{ delete (model.saved.logical_configuration as { logging?: unknown }).logging; });
},60_000);

test('the request logs plugin owns body settings and disabled plugins do not mount their log page', async () => {
  await withSettings(async (page, model) => {
    const size = page.getByTestId('logging-max-size');
    const retention = page.getByTestId('logging-retention-days');
    const save = page.getByTestId('request-logs-save');
    await expect(size).toHaveValue('50');
    await retention.fill('7');
    await size.fill('1.1');
    await expect(save).toBeDisabled();
    await size.fill('6144.5');
    await save.click();
    await expect(page.getByTestId('request-logs-settings').getByRole('status')).toBeVisible();
    await expect(save).toBeDisabled();
    expect(model.writes).toHaveLength(1);
    expect(model.writes[0]!.body.expected_revision).toBe(42);
    expect(model.writes[0]!.body.aggregate.logical_configuration.logging.body)
      .toEqual({ enabled: true, max_size: 6 * 1024 * 1024 + 512, retention_days: 7 });

    await size.fill('');
    await retention.fill('');
    await save.click();
    await expect(page.getByTestId('request-logs-settings').getByRole('status')).toBeVisible();
    await expect(save).toBeDisabled();
    expect(model.writes).toHaveLength(2);
    expect(model.writes[1]!.body.expected_revision).toBe(43);
    expect(model.writes[1]!.body.aggregate.logical_configuration.logging.body)
      .toEqual({ enabled: true, max_size: 64 * 1024, retention_days: 1 });

    model.logsEnabled = false;
    await page.reload();
    await expect(page.getByRole('status').filter({ hasText: 'Disabled' })).toBeVisible();
    await expect(page.getByTestId('request-logs-save')).toHaveCount(0);
    await expect(page.locator(`a[href="${requestLogsMenuPage.href}"]`)).toHaveCount(0);
    await page.goto(`${runtime.origin}${requestLogsMenuPage.href}`);
    await expect(page.getByRole('status').filter({ hasText: 'Disabled' })).toBeVisible();
    await expect(page.getByTestId('page-logs')).toHaveCount(0);
  }, 1440, 'en', 'plugins/request-logs/settings');
}, 60_000);

test('fractional WebSocket message limits and whole-second update timeouts convert before publishing',async()=>{
  await withSettings(async(page,model)=>{
    const size=page.locator('#config-websocket-max-message'),retention=page.locator('#config-websocket-max-connections');
    await size.fill('1.5');await retention.fill('7');
    const timeouts={drain_start_timeout_ms:'7',drain_timeout_ms:'301',worker_exit_timeout_ms:'11'} as const;
    for(const [field,seconds] of Object.entries(timeouts)) await page.locator(`#config-${field}`).fill(seconds);
    // An in-range decimal that cannot become whole bytes must not submit, even after blur.
    await size.fill('1.1');await size.press('Tab');
    await expect(size).toHaveValue('1.1');
    const save=page.getByTestId('config-save-button');
    if(await save.isEnabled()) {
      await save.click();
      await expect(page.getByTestId('settings-notice')).toBeVisible();
      await expect(page.getByTestId('config-review')).toHaveCount(0);
    }
    expect(model.validations).toHaveLength(0);expect(model.writes).toHaveLength(0);
    // Integer fields filter the decimal point instead of accepting it.
    await retention.fill('1.5');await expect(retention).toHaveValue('7');
    await size.fill('1.5');await review(page);
    const validated=model.validations.at(-1).aggregate.logical_configuration;
    expect(validated.websocket_max_message_bytes).toBe(1.5 * 1024 * 1024);
    expect(validated.websocket_max_connections).toBe(7);
    expect(validated.publication).toEqual({drain_start_timeout_ms:7000,drain_timeout_ms:301000,worker_exit_timeout_ms:11000});
    await page.getByTestId('config-confirm-publish').click();
    await expect(page.getByTestId('config-review')).toHaveCount(0);
    expect(model.writes).toHaveLength(1);
    const submitted=model.writes[0]!.body.aggregate.logical_configuration;
    expect(submitted.websocket_max_message_bytes).toBe(1.5 * 1024 * 1024);
    expect(submitted.websocket_max_connections).toBe(7);
    expect(submitted.publication).toEqual({drain_start_timeout_ms:7000,drain_timeout_ms:301000,worker_exit_timeout_ms:11000});
    await waitForSettingsReads(page);
    await expect(size).toHaveValue('1.5');await expect(retention).toHaveValue('7');
    // An invalid size equal to the persisted one must not survive replacing the draft,
    // via Discard or a real reload, and must not leave blocking validity behind.
    for(const reset of ['Discard changes','Reload latest configuration'] as const) {
      await size.fill('1.1');await size.press('Tab');
      await expect(size).toHaveValue('1.1');
      await page.getByRole('combobox',{name:/^(Log Level|日志级别)$/}).click();
      await page.getByRole('option',{name:'Debug',exact:true}).click();
      await expect(size).toHaveValue('1.1');
      if(reset === 'Reload latest configuration') {
        // The reload action is offered by the conflict notice; move the runtime ahead of the snapshot.
        model.revision=44;
        await page.getByRole('button',{name:'Refresh status',exact:true}).click();
      }
      await page.getByRole('button',{name:reset,exact:true}).click();
      await page.getByTestId('confirmation-accept').click();
      await expect(page.getByTestId('confirmation-accept')).toHaveCount(0);
      await expect(size).toHaveValue('1.5');
    }
    await page.getByRole('combobox',{name:/^(Log Level|日志级别)$/}).click();
    await page.getByRole('option',{name:'Warning',exact:true}).click();
    await review(page);await page.getByTestId('config-confirm-publish').click();
    await expect(page.getByTestId('config-review')).toHaveCount(0);
    expect(model.writes).toHaveLength(2);
    expect(model.writes[1]!.body.aggregate.logical_configuration.websocket_max_message_bytes).toBe(1.5 * 1024 * 1024);
  });
},60_000);

test('import review can be cancelled and invalid snapshots are rejected',async()=>{
  const language = 'en';
  await withSettings(async(page,model)=>{
    const candidate={...aggregate()};candidate.logical_configuration.log_level='error';
    candidate.logical_configuration={...candidate.logical_configuration,routes:Array.from({length:65},(_,index)=>({id:crypto.randomUUID(),position:index,path:`/route-${index}`,endpoints:[],plugins:[]}))};
    await upload(page,envelope(candidate));await expect(page.getByTestId('import-preview')).toBeVisible();
    await expect(page.getByRole('combobox',{name:/^(Log Level|日志级别)$/})).toBeDisabled();await review(page);
    await closeReview(page);
    await page.getByRole('button',{name:language==='en'?'Cancel import':'取消导入',exact:true}).click();
    expect(model.writes).toHaveLength(0);
    await upload(page,'invalid snapshot');await expect(page.getByTestId('settings-notice')).toBeVisible();
    await expect(page.getByTestId('import-preview')).toHaveCount(0);
  });
},60_000);

test('submission failures retain the draft, distinguish known rejection from unknown acceptance and never repeat a write',async()=>{
  for(const imported of [false,true]) for(const outcome of ['control_recovering','control_readiness_failed','repository_unavailable','conflict','invalid','non-json','network']) {
    await withSettings(async(page,model)=>{
      model.rejection=outcome==='non-json'||outcome==='network'?'':outcome==='conflict'?'stale_revision':outcome==='invalid'?'invalid_configuration':outcome;
      model.status=outcome==='conflict'?409:outcome==='invalid'?422:503;
      model.networkFailure=outcome==='network';model.nonJson=outcome==='non-json';
      // A lost response is reconciled by its UUID; fail that lookup too to keep the result unconfirmed.
      model.queryStatus=outcome==='network'||outcome==='non-json'?503:outcome==='repository_unavailable'?404:0;
      if(imported) {const next=aggregate();next.logical_configuration.log_level='error';await upload(page,envelope(next));await expect(page.getByTestId('import-preview')).toBeVisible();}
      else await page.locator('#config-websocket-max-message').fill('52');
      await review(page);await page.getByTestId('config-confirm-publish').click();
      const known=['control_recovering','control_readiness_failed','conflict','invalid'].includes(outcome);
      await expect(page.getByTestId('page-config')).toHaveAttribute('data-submission-phase',known?'rejected':'unknown');
      // A known rejection must be readable while the review still covers the page.
      if(known) await expect(page.getByTestId('config-review').getByRole('alert').first()).toBeVisible();
      if(outcome.startsWith('control_')) {
        await expect(page.getByTestId('config-review')).toContainText(/configuration was not saved|配置未保存/i);
        await expect(page.getByTestId('config-review')).not.toContainText('HTTP 503 · control_');
      }
      await closeReview(page);
      if(imported) await expect(page.getByTestId('import-preview')).toBeVisible();else await expect(page.locator('#config-websocket-max-message')).toHaveValue('52');
      // Unknown identity: a second submission (new ID) is never offered, import or direct edit.
      if(!known) await expect(page.getByTestId('config-save-button')).toBeDisabled();
      await expect(page.getByTestId('page-config')).not.toContainText('PRIVATE-ERROR');
      expect(model.writes).toHaveLength(1);expect(model.revision).toBe(42);
    },imported?390:1440,imported?'zh-CN':'en');
  }
},120_000);

test('an unknown response is queried by its original operation identity and survives a page reload without a second submission',async()=>{
  await withSettings(async(page,model)=>{
    model.rejection='repository_unavailable';model.queryStatus=404;await page.locator('#config-websocket-max-message').fill('52');await review(page);
    await page.getByTestId('config-confirm-publish').click();await expect(page.getByTestId('page-config')).toHaveAttribute('data-submission-phase','unknown');
    await closeReview(page);await expect(page.getByTestId('config-save-button')).toBeDisabled();
    model.queryStatus=503;await page.getByRole('button',{name:'Check this save',exact:true}).click();
    await expect(page.getByTestId('page-config')).toHaveAttribute('data-submission-phase','unknown');
    model.queryStatus=0;model.revision=43;model.saved.logical_configuration.websocket_max_message_bytes=52 * 1024 * 1024;
    await page.getByRole('button',{name:'Check this save',exact:true}).click();
    await expect(page.getByTestId('page-config')).toHaveAttribute('data-submission-phase','terminal');
    expect(model.queries).toBeGreaterThan(0);expect(model.writes).toHaveLength(1);
    await reloadSettings(page);await expect(page.locator('#config-websocket-max-message')).toHaveValue('52');expect(model.writes).toHaveLength(1);
  });
},60_000);

test('a failed serving refresh cannot show retained data as fresh and recovers on an explicit refresh',async()=>{
  await withSettings(async(page,model)=>{
    model.runtimeUnavailable=true;await page.getByRole('button',{name:'Refresh status',exact:true}).click();
    await expect(page.getByTestId('runtime-uncertain')).toBeVisible();
    model.runtimeUnavailable=false;await page.getByRole('button',{name:'Refresh status',exact:true}).click();
    await expect(page.getByTestId('runtime-uncertain')).toHaveCount(0);expect(model.writes).toHaveLength(0);
  });
},60_000);

test('later import selection wins over a slow earlier validation response',async()=>{
  await withSettings(async(page,model)=>{
    await holdResponseJson(page,'first-import',{method:'POST',path:'/api/config/validate',bodyIncludes:'"log_level":"debug"'});
    const first=aggregate();first.logical_configuration.log_level='debug';await upload(page,envelope(first));
    await expect.poll(()=>model.validations.length).toBe(1);
    const firstImportResponse=await waitForResponseReceipt(page,'first-import');
    const second=aggregate();second.logical_configuration.log_level='error';await upload(page,envelope(second));
    await expect(page.getByTestId('import-preview')).toBeVisible();
    await releaseResponseJson(page,firstImportResponse);
    await waitForResponseDelivery(page,firstImportResponse);
    await review(page);expect(model.validations.at(-1).aggregate.logical_configuration.log_level).toBe('error');expect(model.writes).toHaveLength(0);
  });
},60_000);

test('an accepted publication keeps tracking and leaves the form editable',async()=>{
  await withSettings(async(page,model)=>{
    model.active=true;model.queryStatus=503;
    let releaseOperation!:()=>void;
    model.operationGate=new Promise<void>(resolve=>{releaseOperation=resolve;});
    try {
      await page.locator('#config-websocket-max-message').fill('52');await review(page);await page.getByTestId('config-confirm-publish').click();
      await expect(page.getByTestId('page-config')).toHaveAttribute('data-submission-phase','active');
      // The ACK ends the save: the review closes, tracking continues and fields stay usable.
      await expect(page.getByTestId('config-review')).toHaveCount(0);
      await expect(page.locator('#config-websocket-max-message')).toBeEnabled();
      // The ACK is the save result: one success toast while it applies.
      await expect(page.getByTestId('toast-container').getByRole('status').filter({hasText:/Saved successfully|保存成功/})).toHaveCount(1);
    } finally { releaseOperation(); }
    await reloadSettings(page);await expect(page.getByTestId('page-config')).toHaveAttribute('data-submission-phase','active');
    await expect(page.locator('#config-websocket-max-message')).toBeEnabled();
    await expect(page.getByRole('button',{name:'Check this save',exact:true})).toBeVisible();
    model.queryStatus=0;model.queryState='degraded';
    await page.getByRole('button',{name:'Check this save',exact:true}).click();
    await expect(page.getByTestId('page-config')).toHaveAttribute('data-submission-phase','terminal');expect(model.writes).toHaveLength(1);
    await expect(page.getByTestId('settings-notice')).toBeVisible();
  });
},60_000);

test('a restored application leaves settings editable until it reaches a terminal state',async()=>{
  for(const terminal of ['converged','degraded'] as const) await withSettings(async(page,model)=>{
    model.id='10000000-0000-4000-8000-000000000009';model.revision=43;model.queryState='draining';
    model.publication=publicationFixture({operation:{operation_id:model.id,committed_revision:43,state:'draining',
      result_status:null,error_code:null,updated_at:1},recovery:null,retryable:false,serving_complete:true,serving_revision:43,target_revision:43});
    await page.evaluate(id=>sessionStorage.setItem('bungee:settings-publication',JSON.stringify({version:1,mutationId:id,accepted:true})),model.id);
    await reloadSettings(page);
    await expect(page.getByTestId('page-config')).toHaveAttribute('data-submission-phase','active');
    await expect(page.locator('#config-websocket-max-message')).toBeEnabled();
    expect(model.queries).toBeGreaterThan(0);
    model.queryState=terminal;
    model.publication={...model.publication,operation:{...model.publication.operation!,state:terminal,
      result_status:terminal==='converged'?200:202,error_code:terminal==='degraded'?'old_worker_drain_failed':null}};
    await expect(page.getByTestId('page-config')).toHaveAttribute('data-submission-phase','terminal');
    await expect(page.locator('#config-websocket-max-message')).toBeEnabled();
    expect(await page.evaluate(()=>sessionStorage.getItem('bungee:settings-publication'))).toBeNull();
    expect(model.writes).toHaveLength(0);
  });
},60_000);

test('local tracking storage failures report a warning and corrupted metadata refuses a new submission',async()=>{
  for(const action of ['setItem','removeItem','corrupt'] as const) await withSettings(async(page,model)=>{
    if(action === 'corrupt') {
      await page.evaluate(()=>sessionStorage.setItem('bungee:settings-publication','{broken'));
      await reloadSettings(page);await expect(page.getByTestId('settings-notice')).toBeVisible();
      await expect(page.locator('#config-websocket-max-message')).toBeEnabled();
      await expect(page.getByTestId('config-save-button')).toBeDisabled();expect(model.writes).toHaveLength(0);return;
    }
    await page.evaluate(action=>{
      const original=Storage.prototype[action];
      Storage.prototype[action]=function(key:string,value?:string) {
        if(this === sessionStorage && key === 'bungee:settings-publication') throw new Error('fixture storage denial');
        return action === 'setItem' ? (original as typeof Storage.prototype.setItem).call(this,key,value!) : (original as typeof Storage.prototype.removeItem).call(this,key);
      };
    },action);
    await page.locator('#config-websocket-max-message').fill('52');await review(page);await page.getByTestId('config-confirm-publish').click();
    await expect(page.getByTestId('config-review')).toHaveCount(0);
    await expect(page.getByTestId('page-config').getByRole('status').filter({hasText:/browser|record|storage/i})).toBeVisible();
    expect(model.writes).toHaveLength(1);
  });
},60_000);

test('dirty settings navigation can be cancelled or confirmed without an implicit save',async()=>{
  for (const width of [1440, 320]) await withSettings(async(page,model)=>{
    const navigateToRoutes = async () => {
      if (width === 320) {
        await page.locator('#header-menu-trigger').click();
        await page.getByTestId('header-menu').getByRole('link',{name:'Routes',exact:true}).click();
      } else {
        await page.getByTestId('header-top-menu').getByRole('button',{name:'Gateway',exact:true}).click();
        await page.getByRole('menuitem',{name:'Routes',exact:true}).click();
      }
    };
    await page.locator('#config-websocket-max-message').fill('52');
    await navigateToRoutes();
    await page.getByTestId('confirmation-cancel').click();await expect(page).toHaveURL(/#\/config$/);
    await expect(page.locator('#config-websocket-max-message')).toHaveValue('52');
    await navigateToRoutes();await page.getByTestId('confirmation-accept').click();await expect(page).toHaveURL(/#\/routes$/);
    expect(model.writes).toHaveLength(0);
  }, width);
},60_000);

test('log cleanup requires confirmation and distinguishes execution, status refresh failure and rejection',async()=>{
  for(const outcome of ['success','refresh-failure','rejected'] as const) await withSettings(async(page,model)=>{
    const start=page.getByTestId('cleanup-start');await expect(start).toBeEnabled();await start.click();
    await page.getByTestId('confirmation-cancel').click();expect(model.cleanupWrites).toBe(0);
    model.cleanupRefreshFailure=outcome === 'refresh-failure';model.cleanupStatus=outcome === 'rejected'?403:0;
    await start.click();await page.getByTestId('confirmation-accept').click();
    await expect(page.getByTestId('cleanup-outcome')).toBeVisible();
    // The execution result appears before the follow-up status refresh finishes.
    await expect(page.getByTestId('logs-maintenance').getByRole('button',{name:'Refresh status',exact:true})).toBeEnabled();
    if(outcome !== 'rejected') await expect(start).toBeDisabled();expect(model.cleanupWrites).toBe(1);
  },1440,'en','plugins/request-logs/settings');
},60_000);

test('a baseline read newer than the ACK cannot be adopted by the older draft', async () => {
  for (const imported of [false, true]) await withSettings(async(page, model) => {
    const next = aggregate();
    next.logical_configuration.websocket_max_message_bytes = 52 * 1024 * 1024;
    if (imported) { await upload(page, envelope(next)); await expect(page.getByTestId('import-preview')).toBeVisible(); }
    else await page.locator('#config-websocket-max-message').fill('52');
    await review(page);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    model.configGate = gate; model.configGateEntered = entered;
    await page.getByTestId('config-confirm-publish').click();
    await started; // the ACK's baseline read is in flight
    const other = aggregate();
    other.logical_configuration.log_level = 'debug';
    model.saved = other; model.revision = 44;
    release();
    await expect(page.getByTestId('settings-notice')).toContainText(/configuration was changed/i);
    await expect(page.locator('#config-websocket-max-message')).toHaveValue('52');
    await expect(page.getByTestId('config-save-button')).toBeDisabled();
    expect(model.writes).toHaveLength(1);
    expect(model.writes[0]!.body.expected_revision).toBe(42);
  }, 1440, 'en');
}, 60_000);

test('a lagging baseline retry reads the confirmed revision and still refuses a foreign snapshot', async () => {
  for (const retry of ['own-revision', 'foreign'] as const) await withSettings(async (page, model) => {
    await page.locator('#config-websocket-max-message').fill('52');
    await review(page);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    model.configGate = gate; model.configGateEntered = entered;
    await page.getByTestId('config-confirm-publish').click();
    await started; // the ACK's baseline read is in flight
    // The baseline read lags behind the committed revision, so the retry stays offered.
    model.revision = 42; model.saved = aggregate();
    release();
    const retryButton = page.getByRole('button', { name: 'Refresh configuration', exact: true });
    await expect(retryButton).toBeVisible();
    await expect(page.locator('#config-websocket-max-message')).toHaveValue('52');
    if (retry === 'foreign') {
      const other = aggregate();
      other.logical_configuration.log_level = 'debug';
      model.saved = other; model.revision = 44;
    } else {
      // The committed revision becomes readable again; the retry adopts it, not a foreign one.
      model.saved = model.writes[0]!.body.aggregate; model.revision = 43;
      await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
      await page.locator('#config-websocket-max-message').fill('1.1');
      await page.locator('#config-websocket-max-message').press('Tab');
    }
    await retryButton.click();
    if (retry === 'foreign') {
      await expect(page.getByTestId('settings-notice')).toContainText(/configuration was changed/i);
      await expect(page.locator('#config-websocket-max-message')).toHaveValue('52');
      await expect(page.getByTestId('config-save-button')).toBeDisabled();
    } else {
      await expect(page.locator('#config-websocket-max-message')).toHaveValue('1.1');
      await expect(retryButton).toHaveCount(0);
    }
    expect(model.writes).toHaveLength(1);
  }, 1440, 'en');
}, 120_000);

test('a missing unacknowledged operation stays unknown on active query and reload until the same ID is confirmed', async () => {
  await withSettings(async(page, model) => {
    model.rejection = 'repository_unavailable'; model.queryStatus = 404;
    await page.locator('#config-websocket-max-message').fill('52');
    await review(page); await page.getByTestId('config-confirm-publish').click();
    await expect(page.getByTestId('page-config')).toHaveAttribute('data-submission-phase', 'unknown');
    await closeReview(page);
    const id = model.id;
    const marker = () => page.evaluate(() => {
      const raw = sessionStorage.getItem('bungee:settings-publication');
      return raw && raw.startsWith('{') ? JSON.parse(raw) : raw ? { version: 1, mutationId: raw, accepted: false } : null;
    });
    expect(id).toBeTruthy();
    expect(await marker()).toEqual({ version: 1, mutationId: id, accepted: false });
    expect(model.writes).toHaveLength(1);

    // A readable snapshot and runtime do not prove the original write was not committed.
    await page.getByRole('button', { name: 'Check this save', exact: true }).click();
    await expect(page.getByTestId('page-config')).toHaveAttribute('data-submission-phase', 'unknown');
    await expect(page.getByTestId('config-save-button')).toBeDisabled();
    await expect(page.locator('#config-websocket-max-message')).toBeEnabled();
    expect(await marker()).toEqual({ version: 1, mutationId: id, accepted: false });
    expect(model.writes).toHaveLength(1);

    // Reload restores the same identity; it must not turn into a new submission.
    model.runtimeUnavailable = false;
    await reloadSettings(page);
    await expect(page.getByTestId('page-config')).toHaveAttribute('data-submission-phase', 'unknown');
    await expect(page.getByTestId('config-save-button')).toBeDisabled();
    await expect(page.locator('#config-websocket-max-message')).toBeEnabled();
    expect(await marker()).toEqual({ version: 1, mutationId: id, accepted: false });
    expect(model.writes).toHaveLength(1);

    // Only a trusted operation with this identity settles the result.
    model.queryStatus = 0; model.queryState = 'converged'; model.revision = 43;
    model.saved.logical_configuration.websocket_max_message_bytes = 52 * 1024 * 1024;
    await page.getByRole('button', { name: 'Check this save', exact: true }).click();
    await expect(page.getByTestId('page-config')).toHaveAttribute('data-submission-phase', 'terminal');

    // A later, legitimate edit may now submit again.
    await page.locator('#config-websocket-max-message').fill('54'); await review(page);
    await page.getByTestId('config-confirm-publish').click();
    await expect(page.getByTestId('config-review')).toHaveCount(0);
    expect(model.writes).toHaveLength(2);
    expect(model.writes[1]!.body.expected_revision).toBe(43);
  });
}, 60_000);

test('a same-ID unknown reconciliation does not adopt a newer snapshot either', async () => {
  await withSettings(async(page, model) => {
    model.rejection = 'repository_unavailable'; model.queryStatus = 404;
    await page.locator('#config-websocket-max-message').fill('52');
    await review(page); await page.getByTestId('config-confirm-publish').click();
    await expect(page.getByTestId('page-config')).toHaveAttribute('data-submission-phase', 'unknown');
    await closeReview(page);
    const other = aggregate();
    other.logical_configuration.log_level = 'debug';
    model.queryStatus = 0; model.queryState = 'converged'; model.saved = other; model.revision = 44;
    await page.getByRole('button', { name: 'Check this save', exact: true }).click();
    await expect(page.getByTestId('page-config')).toHaveAttribute('data-submission-phase', 'terminal');
    await expect(page.getByTestId('settings-notice')).toContainText(/configuration was changed/i);
    await expect(page.locator('#config-websocket-max-message')).toHaveValue('52');
    await expect(page.getByTestId('config-save-button')).toBeDisabled();
    expect(model.writes).toHaveLength(1);
  }, 1440, 'en');
}, 60_000);

test('a missing accepted operation keeps the marker and leaves the form editable',async()=>{
  await withSettings(async(page,model)=>{
    model.active=true;model.queryStatus=404;
    await page.locator('#config-websocket-max-message').fill('52');await review(page);await page.getByTestId('config-confirm-publish').click();
    await expect(page.getByTestId('toast-container')).toContainText(/Saved successfully|保存成功/);
    await expect(page.getByTestId('config-review')).toHaveCount(0);
    await reloadSettings(page);await expect(page.getByTestId('page-config')).toHaveAttribute('data-submission-phase','active');
    await expect(page.locator('#config-websocket-max-message')).toBeEnabled();
    expect(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('bungee:settings-publication')!))).toEqual({version:1,mutationId:model.id,accepted:true});
    expect(model.writes).toHaveLength(1);
    await expect(page.getByRole('button',{name:'Check this save',exact:true})).toBeVisible();
    model.queryStatus=0;model.queryState='degraded';
    await page.getByRole('button',{name:'Check this save',exact:true}).click();
    await expect(page.getByTestId('page-config')).toHaveAttribute('data-submission-phase','terminal');expect(model.writes).toHaveLength(1);
  });
},60_000);


test('edits typed after the ACK survive the baseline refresh',async()=>{
  await withSettings(async(page,model)=>{
    await page.locator('#config-websocket-max-message').fill('52');await review(page);
    await holdResponseJson(page,'settings-rebase',{method:'GET',path:'/api/config'});
    await page.getByTestId('config-confirm-publish').click();
    const rebase=await waitForResponseReceipt(page,'settings-rebase');
    // The ACK closed the review and the baseline read is still held: keep editing.
    await expect(page.getByTestId('config-review')).toHaveCount(0);
    await expect(page.locator('#config-websocket-max-message')).toBeEnabled();
    await page.locator('#config-websocket-max-message').fill('54');
    await releaseResponseJson(page,rebase);await waitForResponseDelivery(page,rebase);
    await expect(page.locator('#config-websocket-max-message')).toHaveValue('54');
    await expect(page.getByTestId('settings-change-bar')).toContainText(/1 change|1 项更改/);
    expect(model.writes).toHaveLength(1);
  });
},60_000);

test('a second save is submitted while the previous application is still running',async()=>{
  await withSettings(async(page,model)=>{
    model.active=true;
    await page.locator('#config-websocket-max-message').fill('52');await review(page);
    await page.getByTestId('config-confirm-publish').click();
    await expect(page.getByTestId('config-review')).toHaveCount(0);
    await expect(page.getByTestId('page-config')).toHaveAttribute('data-submission-phase','active');
    await expect(page.locator('#config-websocket-max-message')).toBeEnabled();
    // The ACK advances the editing baseline even while application is still running.
    await page.locator('#config-websocket-max-message').fill('54');await review(page);
    await page.getByTestId('config-confirm-publish').click();
    await expect(page.getByTestId('config-review')).toHaveCount(0);
    expect(model.writes).toHaveLength(2);
    expect(model.writes[1]!.body.expected_revision).toBe(43);
    expect(model.writes[1]!.body.aggregate.logical_configuration.websocket_max_message_bytes).toBe(54 * 1024 * 1024);
  });
},60_000);

test('WebSocket connection limits publish an integer or explicit null through review and snapshot CAS',async()=>{
  for (const limit of [128,null]) await withSettings(async(page,model)=>{
    if(limit === null) await page.getByRole('switch',{name:'No additional WebSocket connection limit',exact:true}).click();
    else await page.getByRole('spinbutton',{name:'Max WS client connections',exact:true}).fill(String(limit));
    await review(page);
    expect(model.validations.at(-1).aggregate.logical_configuration.websocket_max_connections).toBe(limit);
    await closeReview(page);expect(model.writes).toHaveLength(0);
    await review(page);await page.getByTestId('config-confirm-publish').click();
    await expect(page.getByTestId('config-review')).toHaveCount(0);
    expect(model.writes).toHaveLength(1);
    expect(model.writes[0]!.body.expected_revision).toBe(42);
    expect(model.writes[0]!.body.aggregate.logical_configuration.websocket_max_connections).toBe(limit);
  });
  // "No limit" and 64 MiB in the same submission: the null must survive the
  // disabled numeric control, the write, and the post-publish reset.
  await withSettings(async(page,model)=>{
    const unlimited=page.getByRole('switch',{name:'No additional WebSocket connection limit',exact:true});
    const connections=page.locator('#config-websocket-max-connections');
    await unlimited.click();
    await page.locator('#config-websocket-max-message').fill('64');
    await expect(connections).toBeDisabled();
    await review(page);
    const validated=model.validations.at(-1).aggregate.logical_configuration;
    expect(validated.websocket_max_connections).toBeNull();
    expect(validated.websocket_max_message_bytes).toBe(64*1024*1024);
    await page.getByTestId('config-confirm-publish').click();
    await expect(page.getByTestId('config-review')).toHaveCount(0);
    expect(model.writes).toHaveLength(1);
    const submitted=model.writes[0]!.body.aggregate.logical_configuration;
    expect(submitted.websocket_max_connections).toBeNull();
    expect(submitted.websocket_max_message_bytes).toBe(64*1024*1024);
    await waitForSettingsReads(page);
    await expect(unlimited).toHaveAttribute('aria-checked','true');
    await expect(connections).toBeDisabled();
    await expect(page.locator('#config-websocket-max-message')).toHaveValue('64');
  });
},60_000);

test('empty and out-of-range WebSocket limits cannot validate or publish a retained valid draft',async()=>{
  await withSettings(async(page,model)=>{
    const input=page.getByRole('spinbutton',{name:'Max WS client connections',exact:true});
    for(const invalid of ['', '0', '2147483648', '999999999999999999999999999']) {
      await input.fill(invalid);
      await expect(page.getByTestId('config-save-button')).toBeDisabled();
      expect(model.validations).toHaveLength(0);expect(model.writes).toHaveLength(0);
    }
    await input.fill('2147483647');await review(page);await page.getByTestId('config-confirm-publish').click();
    await expect(page.getByTestId('config-review')).toHaveCount(0);
    expect(model.writes).toHaveLength(1);
    expect(model.writes[0]!.body.aggregate.logical_configuration.websocket_max_connections).toBe(2147483647);
  });
},60_000);

test('imported WebSocket limits are read-only and publish the import while cancellation retains the local draft',async()=>{
  for(const limit of [321,null]) await withSettings(async(page,model)=>{
    const input=page.getByRole('spinbutton',{name:'Max WS client connections',exact:true});
    await input.fill('600');
    const next=aggregate();next.logical_configuration.websocket_max_connections=limit;
    await upload(page,envelope(next));await expect(page.getByTestId('import-preview')).toBeVisible();
    const unlimited=page.getByRole('switch',{name:'No additional WebSocket connection limit',exact:true});
    await expect(unlimited).toBeDisabled();
    if(limit === null) await expect(unlimited).toHaveAttribute('aria-checked','true');
    else {await expect(input).toBeDisabled();await expect(input).toHaveValue(String(limit));}
    await page.getByRole('button',{name:'Cancel import',exact:true}).click();
    await expect(input).toHaveValue('600');expect(model.writes).toHaveLength(0);
    await upload(page,envelope(next));await expect(page.getByTestId('import-preview')).toBeVisible();
    await review(page);await page.getByTestId('config-confirm-publish').click();
    await expect(page.getByTestId('config-review')).toHaveCount(0);
    expect(model.writes).toHaveLength(1);
    expect(model.writes[0]!.path).toBe('/api/config/import');
    expect(model.writes[0]!.body.envelope.aggregate.logical_configuration.websocket_max_connections).toBe(limit);
  });
},60_000);


test('message size validates the visible draft and publishes fractional or larger sizes through review and snapshot CAS', async () => {
  await withSettings(async (page, model) => {
    const input = page.locator('#config-websocket-max-message');
    // The numeric filter drops the sign; no negative MiB value reaches the draft.
    await input.fill('-1');
    expect(await input.inputValue()).not.toContain('-');
    expect(model.validations).toHaveLength(0);
    // 1.1 MiB is in range but not a whole number of bytes.
    for (const invalid of ['', '0', '2048', '1.1']) {
      await input.fill(invalid);
      await expect(page.getByTestId('config-save-button')).toBeDisabled();
      expect(model.validations).toHaveLength(0); expect(model.writes).toHaveLength(0);
    }
    await input.fill('1.5'); await review(page);
    expect(model.validations.at(-1).aggregate.logical_configuration.websocket_max_message_bytes).toBe(1.5 * 1024 * 1024);
    await closeReview(page); expect(model.writes).toHaveLength(0);
    await input.fill('64'); await review(page);
    expect(model.validations.at(-1).aggregate.logical_configuration.websocket_max_message_bytes).toBe(64 * 1024 * 1024);
    await closeReview(page); expect(model.writes).toHaveLength(0);
    await review(page); await page.getByTestId('config-confirm-publish').click();
    await expect(page.getByTestId('config-review')).toHaveCount(0);
    expect(model.writes).toHaveLength(1);
    expect(model.writes[0]!.body.expected_revision).toBe(42);
    expect(model.writes[0]!.body.aggregate.logical_configuration.websocket_max_message_bytes).toBe(64 * 1024 * 1024);
    await waitForSettingsReads(page);
    await expect(input).toHaveValue('64');
    await expect(input).toBeEnabled();
  });
}, 60_000);

test('message size import is read-only and cancellation preserves the local draft', async () => {
  await withSettings(async (page, model) => {
    const input = page.locator('#config-websocket-max-message');
    await input.fill('64');
    const next = aggregate(); next.logical_configuration.websocket_max_message_bytes = 128 * 1024 * 1024;
    await upload(page, envelope(next)); await expect(page.getByTestId('import-preview')).toBeVisible();
    await expect(input).toBeDisabled();
    await page.getByRole('button', { name: 'Cancel import', exact: true }).click();
    await expect(input).toHaveValue('64'); expect(model.writes).toHaveLength(0);
    await upload(page, envelope(next)); await expect(page.getByTestId('import-preview')).toBeVisible();
    await review(page); await page.getByTestId('config-confirm-publish').click();
    await expect(page.getByTestId('config-review')).toHaveCount(0);
    expect(model.writes).toHaveLength(1);
    expect(model.writes[0]!.body.envelope.aggregate.logical_configuration.websocket_max_message_bytes).toBe(128 * 1024 * 1024);
    await waitForSettingsReads(page);
    await expect(input).toHaveValue('128');
    await expect(input).toBeEnabled();
  });
}, 60_000);
