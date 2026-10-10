import { beforeAll, afterAll, expect, test } from 'bun:test';
import { chromium, expect as rendered, type Browser, type Page } from 'playwright/test';
import { resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { startUiRuntime } from '../../../../../tests/helpers/ui-runtime';
import { configurationRuntimeFixture, publicationFixture } from '../../helpers/publication';

let runtime: Awaited<ReturnType<typeof startUiRuntime>>, browser: Browser;
beforeAll(async () => {
  runtime = await startUiRuntime({ mode: 'built-page' });
  try { browser = await chromium.launch(); } catch (error) { await runtime.close(); throw error; }
}, 120_000);
afterAll(async () => { try { await browser?.close(); } finally { await runtime?.close(); } });

async function withLogs(answer: (request: Request) => Promise<Response>, run: (page: Page, queries: URL[]) => Promise<void>) {
  const context = await browser.newContext({viewport:{width:1440,height:900}});
  try {
    const page = await context.newPage(), errors: string[] = [], queries: URL[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { localStorage.setItem('locale','en');localStorage.setItem('logsAutoRefresh','false'); });
    const config = configurationRuntimeFixture(publicationFixture({operation:null,recovery:null,retryable:false,serving_complete:true,serving_revision:1,target_revision:1}));
    await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async route => {
      const url = new URL(route.request().url());
      if(url.pathname === '/api/logs' || url.pathname === '/api/logs/export') {
        queries.push(url);
        const response = await answer(new Request(url));
        return route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()});
      }
      const json = (value:unknown) => route.fulfill({json:value});
      if(url.pathname === '/api/auth/mode') return json({mode:'anonymous',publicOrigin:runtime.origin});
      if(url.pathname === '/api/auth/verify') return json({success:true,mode:'anonymous',subject:{id:'anonymous',provider:'anonymous'}});
      if(url.pathname === '/api/config/runtime') return json(config);
      if(url.pathname === '/api/config') return json({revision:1,content_hash:config.content_hash,config:config.config});
      if(url.pathname === '/api/plugins') return json([]);
      if(url.pathname === '/api/plugin-translations' || url.pathname === '/api/logs/cleanup/config') return json({});
      if(url.pathname === '/api/resources/api-key') return json({keys:[]});
      errors.push(`Unexpected API ${url.pathname}`);return route.fulfill({status:500,json:{error:'unexpected_request'}});
    });
    await page.goto(`${runtime.origin}/#/logs`);
    await rendered(page.getByTestId('logs-table-scroll')).toBeVisible();
    await run(page,queries);expect(errors).toEqual([]);
  } finally {await context.close();}
}
async function transport(page:Page,name:string) {
  await page.getByRole('button',{name:/^Transport outcome/}).click();
  await page.getByRole('menuitem',{name,exact:true}).click();
}
async function status(page:Page,value:string) {
  await page.getByRole('button',{name:/^HTTP status/}).click();
  await page.getByPlaceholder('200, 404, 5xx').first().fill(value);
  await page.keyboard.press('Escape');
}

test('real Logs rows split HTTP, final transport and retries; filters and reset use the chain API', async () => {
  const now=Date.now();
  const rows=[[200,'completed'],[200,'cancelled'],[200,'failed'],[500,'completed'],[200,undefined]].map(([status,outcome],index)=>({
    id:index,requestId:`request-${index}`,chainId:`chain-${index}`,method:'POST',path:`/test/${index}`,chainStatus:status,status,
    timestamp:now,chainStartTs:now,chainEndTs:now,chainDurationMs:12,chainAttempts:index===0?3:1,hasRetry:index===0,
    transportOutcome:index===0?'failed':'completed',chainTransportOutcome:outcome,success:true,upstream:'http://upstream',
  }));
  await withLogs(async()=>Response.json({data:rows,total:5,totalPages:1,page:1,limit:50}),async(page,queries)=>{
    await rendered(page.locator('table tbody tr')).toHaveCount(5);
    const cells=await page.locator('table tbody tr').evaluateAll(rows=>rows.map(row=>[...row.querySelectorAll('td')].map(cell=>cell.textContent?.trim())));
    expect(cells.map(row=>row[3])).toEqual(['200','200','200','500','200']);
    expect(cells.map(row=>row[4])).toEqual(['Completed','Cancelled','Transport failed','Completed','Unknown']);
    expect(cells[0][6]).toContain('3');
    await transport(page,'Cancelled');
    await rendered.poll(()=>queries.at(-1)?.searchParams.get('transportOutcome')).toBe('cancelled');
    await status(page,'200,500');
    await rendered.poll(()=>queries.at(-1)?.searchParams.getAll('status')).toEqual(['200','500']);
    expect(queries.at(-1)!.searchParams.get('groupBy')).toBe('chain');
    expect(queries.at(-1)!.searchParams.has('success')).toBe(false);
    await page.getByRole('button',{name:'Reset filters',exact:true}).click();
    await rendered.poll(()=>queries.at(-1)?.searchParams.has('transportOutcome')).toBe(false);
    expect(queries.at(-1)!.searchParams.has('status')).toBe(false);
    await rendered(page.getByRole('button',{name:'Transport outcome',exact:true})).toHaveText('Transport outcome');
  });
},60_000);

test('browser filters and CSV exports match the real SQLite chain API', async () => {
  const root=mkdtempSync(resolve(tmpdir(),'bungee-ui-sqlite-'));
  let db:Database|undefined;
  try {
    // Load the backend at runtime so the UI checker does not include the entire core project.
    const core = resolve(import.meta.dir, '../../../../core/src');
    const [{ MigrationManager }, { LogQueryService }, { LogsHandler }] = await Promise.all([
      import(`${core}/migrations`), import(`${core}/api/logs`), import(`${core}/api/handlers/logs`),
    ]);
    const dbPath = resolve(root, 'access.db');
    expect((await new MigrationManager(dbPath).migrate()).success).toBeTrue();
    db = new Database(dbPath);
    const insert = db.query(`INSERT INTO access_logs (request_id,timestamp,method,path,status,duration,created_at,request_type,parent_request_id,attempt_number,transport_outcome)
      VALUES (?,?, 'POST', ?, ?, 10, ?, ?, ?, ?, ?)`);
    const now = Date.now() - 1000;
    insert.run('actual-retry', now, '/actual/retry', 503, now / 1000, 'retry', 'actual-chain', 1, 'failed');
    insert.run('actual-final', now + 10, '/actual/final', 200, now / 1000, 'final', 'actual-chain', 2, 'completed');
    insert.run('actual-cancel', now, '/actual/cancel', 200, now / 1000, 'final', null, null, 'cancelled');
    insert.run('actual-http500', now, '/actual/http500', 500, now / 1000, 'final', null, null, 'completed');
    const handler = new LogsHandler({ logQueryService: new LogQueryService(db), bodyStorage: {} as any,
      headerStorage: {} as any, cleanupService: {} as any });

    await withLogs(request => new URL(request.url).pathname.endsWith('/export') ? handler.export(request) : handler.query(request),async(page)=>{
      await rendered(page.locator('table tbody tr')).toHaveCount(3);
      const rows=await page.locator('table tbody tr').allTextContents();
      expect(rows.find(row=>row.includes('/actual/retry'))).toContain('Completed');
      await transport(page,'Completed');await rendered(page.locator('table tbody tr')).toHaveCount(2);
      await status(page,'500');await rendered(page.locator('table tbody tr')).toHaveCount(1);
      await rendered(page.locator('table tbody')).toContainText('/actual/http500');
      await page.getByRole('button',{name:'Export',exact:true}).click();
      const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('menuitem',{name:'CSV',exact:true}).click()]);
      const csv=await Bun.file((await download.path())!).text();
      expect(csv).toContain('actual-http500');expect(csv).toContain(',completed,');
      expect(csv).not.toContain('actual-retry');expect(csv).not.toContain('actual-cancel');
    });
  } finally {db?.close();rmSync(root,{recursive:true,force:true});}
},60_000);
