import { afterAll, beforeAll, test } from 'bun:test';
import { chromium, expect, type Browser, type Page } from 'playwright/test';
import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import type { ConfigurationOperationState } from '../../src/api/config';
import { startUiRuntime } from '../../../../tests/helpers/ui-runtime';
import { configurationRuntimeFixture, publicationFixture } from '../helpers/publication';

let runtime: Awaited<ReturnType<typeof startUiRuntime>>, browser: Browser;
beforeAll(async () => {
  runtime = await startUiRuntime({ mode: 'built-page' });
  try { browser = await chromium.launch(); } catch (error) { await runtime.close(); throw error; }
}, 120_000);
afterAll(async () => { try { await browser?.close(); } finally { await runtime?.close(); } });
const aggregate = (): ConfigurationAggregateV2 => ({ logical_configuration: { log_level: 'info', routes: [], services: [], plugins: [],
  logging: { body: { enabled: true, max_size: 51200, retention_days: 1 } } }, plugin_activations: [] });
const digest = `sha256:${'a'.repeat(64)}` as const;
const envelope = (value: ConfigurationAggregateV2) => ({format:'bungee-config-snapshot',format_version:1,schema_version:2,
  exported_at:1,source_revision:42,content_hash:digest,envelope_hash:digest,aggregate:value});
function operation(id: string, state: 'converged' | 'committed' | 'degraded' = 'converged'): ConfigurationOperationState {
  return { operation: { mutation_id:id, request_hash:digest, expected_revision:42, committed_revision:43, kind:'config',
    target_worker_count:2,drain_recovery_generation:0,last_drain_recovery_previous_generation:null,created_at:1,updated_at:1,
    state, result_status:state === 'converged' ? 200 : null,error_code:null,error_detail:null } as ConfigurationOperationState['operation'], workers:[] };
}
async function withSettings(run: (page: Page, model: ReturnType<typeof createModel>) => Promise<void>, width=1440, language='en', route='config') {
  const context = await browser.newContext({viewport:{width,height:900}}), page=await context.newPage();
  const errors: string[] = []; page.on('pageerror', error=>errors.push(error.message));
  await page.addInitScript(language=>localStorage.setItem('locale',language),language);
  const model=createModel();
  await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/,async route=>{
    const request=route.request(), path=new URL(request.url()).pathname, method=request.method();
    const json=(value:unknown,status=200)=>route.fulfill({json:value,status});
    if(path === '/api/auth/mode') return json({mode:'anonymous',publicOrigin:runtime.origin});
    if(path === '/api/auth/verify') return json({success:true,mode:'anonymous',subject:{id:'anonymous',provider:'anonymous'}});
    if(path === '/api/plugins') return json([]);
    if(path === '/api/plugin-translations') return json({});
    if(path === '/api/resources/api-key') return json({keys:[]});
    if(path === '/api/config/runtime') return model.runtimeUnavailable ? json({error:'runtime_unavailable'},503) : json({
      ...configurationRuntimeFixture(publicationFixture({operation:null,recovery:null,retryable:false,serving_complete:true,
        serving_revision:model.revision,target_revision:model.revision})),config:model.saved});
    if(path === '/api/config' && method === 'GET') return json({revision:model.revision,content_hash:digest,config:model.saved});
    if(path === '/api/logs') return json({data:[],total:0,totalPages:0,page:1,limit:50});
    if(path === '/api/logs/cleanup/config') return model.cleanupRefreshFailure && model.cleanupWrites ? json({error:'offline'},503) : json({enabled:true,retentionDays:1,scheduleIntervalHours:1,isActive:true});
    if(path === '/api/logs/cleanup') {model.cleanupWrites++;return model.cleanupStatus ? json({error:'rejected'},model.cleanupStatus) : json({success:true});}
    if(path === '/api/config/export') {model.exports++;return json(envelope(model.saved));}
    if(path === '/api/config/validate') {
      const body=request.postDataJSON(); model.validations.push(body);
      if(model.validationGate) await model.validationGate;
      return body.envelope ? json({valid:true,errors:[],aggregate:body.envelope.aggregate,warnings:[]}) : json({valid:true,errors:[]});
    }
    if(path === '/api/config' && method === 'PUT' || path === '/api/config/import' && method === 'POST') {
      const body=request.postDataJSON(); model.writes.push({method,path,body}); model.id=body.mutation_id;
      if(model.rejection) return json({error:model.rejection,reason:'lease_margin',message:'PRIVATE-ERROR',aggregate:{secret:'PRIVATE-ERROR'}},model.status);
      if(model.networkFailure) return route.abort('connectionreset');
      if(model.nonJson) return route.fulfill({status:503,contentType:'text/plain',body:'PRIVATE-ERROR'});
      model.saved=body.aggregate ?? body.envelope.aggregate;model.revision=43;
      return json({...operation(model.id,model.active?'committed':'converged'),operation_id:model.id,revision:43},202);
    }
    if(path.startsWith('/api/config/operations/')) {model.queries++;return model.queryStatus ? json({error:'unavailable'},model.queryStatus) : json(operation(model.id,model.queryState));}
    errors.push(`Unexpected API ${method} ${path}`);return json({error:'unexpected_request'},500);
  });
  try {
    await page.goto(`${runtime.origin}/#/${route}`);
    if (route === 'config') {
      await expect(page.getByTestId('logging-max-size')).toHaveValue('50');
      await expect(page.getByRole('combobox',{name:/^(Log Level|日志级别)$/})).toBeEnabled();
    } else await expect(page.getByTestId('logs-maintenance')).toBeVisible();
    await run(page,model);expect(errors).toEqual([]);
  } finally { model.releaseValidation?.(); await context.close(); }
}
function createModel() {
  return {saved:aggregate(),revision:42,id:'',writes:[] as Array<{method:string;path:string;body:any}>,validations:[] as any[],exports:0,
    active:false,queryState:'converged' as 'converged'|'degraded',cleanupWrites:0,cleanupStatus:0,cleanupRefreshFailure:false,queries:0,rejection:'',status:503,networkFailure:false,nonJson:false,queryStatus:0,runtimeUnavailable:false,
    validationGate:undefined as Promise<void>|undefined,releaseValidation:undefined as (()=>void)|undefined};
}
async function review(page:Page) {
  await page.getByTestId('config-save-button').click();
  await expect(page.getByTestId('config-confirm-publish')).toBeEnabled();
}
async function closeReview(page:Page) {
  await page.getByRole('dialog').getByRole('button',{name:/Close review|关闭审阅/,exact:true}).click();
  await expect(page.getByTestId('config-review')).toHaveCount(0);
}
async function upload(page:Page,value:unknown) {
  await page.getByTestId('config-import-input').setInputFiles({name:'snapshot.json',mimeType:'application/json',buffer:Buffer.from(typeof value==='string'?value:JSON.stringify(value))});
}

test('review, cancellation, publication and export preserve the current draft and use snapshot CAS',async()=>{
  await withSettings(async(page,model)=>{
    await page.getByTestId('logging-max-size').fill('52');await review(page);
    await expect(page.getByTestId('config-diff')).toContainText('52');
    await closeReview(page);await expect(page.getByTestId('logging-max-size')).toHaveValue('52');expect(model.writes).toHaveLength(0);
    await review(page);await page.getByTestId('config-confirm-publish').click();
    await expect(page.getByTestId('config-review')).toHaveCount(0);
    expect(model.writes).toHaveLength(1);expect(model.writes[0]!.body.expected_revision).toBe(42);
    expect(model.writes[0]!.body.aggregate.logical_configuration.logging.body.max_size).toBe(53248);
    await page.getByRole('button',{name:'Snapshot actions',exact:true}).click();
    await page.getByRole('menuitem',{name:'Export snapshot',exact:true}).click();
    await page.getByTestId('confirmation-cancel').click();expect(model.exports).toBe(0);
    await page.getByRole('button',{name:'Snapshot actions',exact:true}).click();
    await page.getByRole('menuitem',{name:'Export snapshot',exact:true}).click();
    const downloaded=page.waitForEvent('download');await page.getByTestId('confirmation-accept').click();await downloaded;expect(model.exports).toBe(1);
  });
},60_000);

test('import preview and review work in both languages without exposing configuration secrets or overflowing',async()=>{
  for(const [width,language] of [[390,'zh-CN'],[1440,'en']] as const) await withSettings(async(page,model)=>{
    const candidate={...aggregate()};candidate.logical_configuration.log_level='error';
    candidate.logical_configuration={...candidate.logical_configuration,routes:Array.from({length:65},(_,index)=>({id:crypto.randomUUID(),position:index,path:`/route-${index}`,endpoints:[],plugins:[]}))};
    await upload(page,envelope(candidate));await expect(page.getByTestId('import-preview')).toBeVisible();
    await expect(page.getByRole('combobox',{name:/^(Log Level|日志级别)$/})).toBeDisabled();await review(page);
    await page.keyboard.press('Tab');expect(await page.evaluate(()=>!!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth+1)).toBe(true);
    await page.keyboard.press('Escape');await expect(page.getByTestId('config-review')).toHaveCount(0);
    await page.getByRole('button',{name:language==='en'?'Cancel import':'取消导入',exact:true}).click();
    expect(model.writes).toHaveLength(0);
    await upload(page,'invalid snapshot');await expect(page.getByTestId('settings-notice')).toBeVisible();
    await expect(page.getByTestId('import-preview')).toHaveCount(0);
  },width,language);
},60_000);

test('submission failures retain the draft, distinguish known rejection from unknown acceptance and never repeat a write',async()=>{
  for(const imported of [false,true]) for(const outcome of ['control_recovering','control_readiness_failed','repository_unavailable','conflict','invalid','non-json','network']) {
    await withSettings(async(page,model)=>{
      model.rejection=outcome==='non-json'||outcome==='network'?'':outcome==='conflict'?'stale_revision':outcome==='invalid'?'invalid_configuration':outcome;
      model.status=outcome==='conflict'?409:outcome==='invalid'?422:503;
      model.networkFailure=outcome==='network';model.nonJson=outcome==='non-json';
      if(imported) {const next=aggregate();next.logical_configuration.log_level='error';await upload(page,envelope(next));await expect(page.getByTestId('import-preview')).toBeVisible();}
      else await page.getByTestId('logging-max-size').fill('52');
      await review(page);await page.getByTestId('config-confirm-publish').click();
      const known=['control_recovering','control_readiness_failed','conflict','invalid'].includes(outcome);
      await expect(page.getByTestId('page-config')).toHaveAttribute('data-submission-phase',known?'rejected':'unknown');
      await closeReview(page);
      if(imported) await expect(page.getByTestId('import-preview')).toBeVisible();else await expect(page.getByTestId('logging-max-size')).toHaveValue('52');
      await expect(page.getByTestId('page-config')).not.toContainText('PRIVATE-ERROR');
      expect(model.writes).toHaveLength(1);expect(model.revision).toBe(42);
    },imported?390:1440,imported?'zh-CN':'en');
  }
},120_000);

test('an unknown response is queried by its original operation identity and survives a page reload without a second submission',async()=>{
  await withSettings(async(page,model)=>{
    model.rejection='repository_unavailable';await page.getByTestId('logging-max-size').fill('52');await review(page);
    await page.getByTestId('config-confirm-publish').click();await expect(page.getByTestId('page-config')).toHaveAttribute('data-submission-phase','unknown');
    await closeReview(page);await expect(page.getByTestId('config-save-button')).toBeDisabled();
    model.queryStatus=503;await page.getByRole('button',{name:'Check this publication',exact:true}).click();
    await expect(page.getByTestId('page-config')).toHaveAttribute('data-submission-phase','unknown');
    model.queryStatus=0;model.revision=43;model.saved.logical_configuration.logging!.body!.max_size=53248;
    await page.getByRole('button',{name:'Check this publication',exact:true}).click();
    await expect(page.getByTestId('page-config')).toHaveAttribute('data-submission-phase','terminal');
    expect(model.queries).toBeGreaterThan(0);expect(model.writes).toHaveLength(1);
    await page.reload();await expect(page.getByTestId('logging-max-size')).toHaveValue('52');expect(model.writes).toHaveLength(1);
  });
},60_000);

test('a failed serving refresh cannot show retained data as fresh and recovers on an explicit refresh',async()=>{
  await withSettings(async(page,model)=>{
    model.runtimeUnavailable=true;await page.getByRole('button',{name:'Refresh status',exact:true}).click();
    await expect(page.getByTestId('settings-serving-state')).toContainText(/unknown|stale/i);
    model.runtimeUnavailable=false;await page.getByRole('button',{name:'Refresh status',exact:true}).click();
    await expect(page.getByTestId('settings-serving-state')).toContainText(/confirmed/i);expect(model.writes).toHaveLength(0);
  });
},60_000);

test('later import selection wins over a slow earlier validation response',async()=>{
  await withSettings(async(page,model)=>{
    model.validationGate=new Promise(resolve=>model.releaseValidation=resolve);
    const first=aggregate();first.logical_configuration.log_level='debug';await upload(page,envelope(first));
    await expect.poll(()=>model.validations.length).toBe(1);
    model.validationGate=undefined;const second=aggregate();second.logical_configuration.log_level='error';await upload(page,envelope(second));
    await expect(page.getByTestId('import-preview')).toBeVisible();model.releaseValidation!();
    await review(page);expect(model.validations.at(-1).aggregate.logical_configuration.log_level).toBe('error');expect(model.writes).toHaveLength(0);
  });
},60_000);

test('accepted publication stays locked across query failure and reload, then exposes degradation without resubmitting',async()=>{
  await withSettings(async(page,model)=>{
    model.active=true;model.queryStatus=503;
    await page.getByTestId('logging-max-size').fill('52');await review(page);await page.getByTestId('config-confirm-publish').click();
    await expect(page.getByTestId('page-config')).toHaveAttribute('data-submission-phase','active');await closeReview(page);
    await page.reload();await expect(page.getByTestId('page-config')).toHaveAttribute('data-submission-phase','active');
    await expect(page.getByTestId('logging-max-size')).toBeDisabled();
    model.queryStatus=0;model.queryState='degraded';await page.getByRole('button',{name:'Check this publication',exact:true}).click();
    await expect(page.getByTestId('page-config')).toHaveAttribute('data-submission-phase','terminal');expect(model.writes).toHaveLength(1);
    await expect(page.getByTestId('settings-notice')).toContainText(/incomplete result/i);
  });
},60_000);

test('local tracking storage failures report a warning and corrupted metadata refuses a new submission',async()=>{
  for(const action of ['setItem','removeItem','corrupt'] as const) await withSettings(async(page,model)=>{
    if(action === 'corrupt') {
      await page.evaluate(()=>sessionStorage.setItem('bungee:settings-publication','{broken'));
      await page.reload();await expect(page.getByTestId('settings-notice')).toBeVisible();
      await expect(page.getByTestId('logging-max-size')).toBeDisabled();expect(model.writes).toHaveLength(0);return;
    }
    await page.evaluate(action=>{
      const original=Storage.prototype[action];
      Storage.prototype[action]=function(key:string,value?:string) {
        if(this === sessionStorage && key === 'bungee:settings-publication') throw new Error('fixture storage denial');
        return action === 'setItem' ? (original as typeof Storage.prototype.setItem).call(this,key,value!) : (original as typeof Storage.prototype.removeItem).call(this,key);
      };
    },action);
    await page.getByTestId('logging-max-size').fill('52');await review(page);await page.getByTestId('config-confirm-publish').click();
    await expect(page.getByTestId('config-review')).toHaveCount(0);
    await expect(page.getByTestId('page-config').getByRole('status').filter({hasText:/tracking identity|local|storage/i})).toBeVisible();
    expect(model.writes).toHaveLength(1);
  });
},60_000);

test('dirty settings navigation can be cancelled or confirmed without an implicit save',async()=>{
  await withSettings(async(page,model)=>{
    await page.getByTestId('logging-max-size').fill('52');
    const routes=page.getByRole('link',{name:'Routes',exact:true});await routes.click();
    await page.getByTestId('confirmation-cancel').click();await expect(page).toHaveURL(/#\/config$/);
    await expect(page.getByTestId('logging-max-size')).toHaveValue('52');
    await routes.click();await page.getByTestId('confirmation-accept').click();await expect(page).toHaveURL(/#\/routes$/);
    await expect(page.getByRole('button',{name:'New Route',exact:true})).toHaveAccessibleName('New Route');expect(model.writes).toHaveLength(0);
  });
},60_000);

test('log cleanup requires confirmation and distinguishes execution, status refresh failure and rejection',async()=>{
  for(const outcome of ['success','refresh-failure','rejected'] as const) await withSettings(async(page,model)=>{
    await page.getByTestId('logs-maintenance').locator('summary').click();
    const start=page.getByTestId('cleanup-start');await expect(start).toBeEnabled();await start.click();
    await page.getByTestId('confirmation-cancel').click();expect(model.cleanupWrites).toBe(0);await expect(start).toBeFocused();
    model.cleanupRefreshFailure=outcome === 'refresh-failure';model.cleanupStatus=outcome === 'rejected'?403:0;
    await start.click();await page.getByTestId('confirmation-accept').click();
    await expect(page.getByTestId('cleanup-outcome')).toContainText(outcome === 'success'?/executed/i:outcome === 'refresh-failure'?/refresh.*fail/i:/reject/i);
    if(outcome !== 'rejected') await expect(start).toBeDisabled();expect(model.cleanupWrites).toBe(1);
  },1440,'en','logs');
},60_000);

test('a missing unacknowledged operation reloads only after both snapshot and serving reads succeed',async()=>{
  await withSettings(async(page,model)=>{
    model.rejection='repository_unavailable';model.queryStatus=404;
    await page.getByTestId('logging-max-size').fill('52');await review(page);await page.getByTestId('config-confirm-publish').click();
    await expect(page.getByTestId('page-config')).toHaveAttribute('data-submission-phase','unknown');await closeReview(page);
    const firstId=model.id;model.runtimeUnavailable=true;
    await page.getByRole('button',{name:'Check this publication',exact:true}).click();
    await expect(page.getByTestId('settings-notice')).toContainText(/runtime|serving/i);
    await expect(page.getByTestId('page-config')).toHaveAttribute('data-submission-phase','unknown');
    await expect(page.getByTestId('logging-max-size')).toHaveValue('52');await expect(page.getByTestId('logging-max-size')).toBeDisabled();
    expect(model.writes).toHaveLength(1);expect(model.id).toBe(firstId);
    model.runtimeUnavailable=false;await page.getByRole('button',{name:'Check this publication',exact:true}).click();
    await expect(page.getByTestId('page-config')).toHaveAttribute('data-submission-phase','rejected');
    await expect(page.getByTestId('logging-max-size')).toHaveValue('50');await expect(page.getByTestId('logging-max-size')).toBeEnabled();
    expect(await page.evaluate(()=>sessionStorage.getItem('bungee:settings-publication'))).toBeNull();expect(model.writes).toHaveLength(1);
    model.rejection='';model.queryStatus=0;
    await page.getByTestId('logging-max-size').fill('52');await review(page);await page.getByTestId('config-confirm-publish').click();
    await expect(page.getByTestId('config-review')).toHaveCount(0);
    expect(model.writes).toHaveLength(2);expect(model.id).not.toBe(firstId);expect(model.writes[1]!.body.expected_revision).toBe(42);
  });
},60_000);

test('a missing accepted operation remains locked across reload and never authorizes a second submission',async()=>{
  await withSettings(async(page,model)=>{
    model.active=true;model.queryStatus=404;
    await page.getByTestId('logging-max-size').fill('52');await review(page);await page.getByTestId('config-confirm-publish').click();
    await expect(page.getByTestId('settings-notice')).toBeVisible();await closeReview(page);
    await page.reload();await expect(page.getByTestId('page-config')).toHaveAttribute('data-submission-phase','active');
    await expect(page.getByTestId('logging-max-size')).toBeDisabled();
    expect(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('bungee:settings-publication')!))).toEqual({version:1,mutationId:model.id,accepted:true});
    expect(model.writes).toHaveLength(1);
    model.queryStatus=0;model.queryState='degraded';await page.getByRole('button',{name:'Check this publication',exact:true}).click();
    await expect(page.getByTestId('page-config')).toHaveAttribute('data-submission-phase','terminal');expect(model.writes).toHaveLength(1);
  });
},60_000);
