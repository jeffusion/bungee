import { beforeAll, afterAll, expect, test } from 'bun:test';
import { chromium, type Browser, type Page } from 'playwright';
import { fileURLToPath } from 'node:url';
import { startUiRuntime } from '../../../../../../../tests/helpers/ui-runtime';

let runtime: Awaited<ReturnType<typeof startUiRuntime>>, browser: Browser;
beforeAll(async () => {
  runtime = await startUiRuntime({ mode: 'component-fixture', entries: ['tests/fixtures/components/body/index.html'], aliases: [
    { find: "$api/config", replacement: fileURLToPath(new URL("../../../../fixtures/components/body/api-config.js", import.meta.url)) },
    { find: "$api/logs", replacement: fileURLToPath(new URL("../../../../fixtures/components/body/api-logs.js", import.meta.url)) },
    { find: "$i18n", replacement: fileURLToPath(new URL("../../../../fixtures/components/body/i18n.js", import.meta.url)) },
    { find: "$components/industrial", replacement: fileURLToPath(new URL("../../../../fixtures/components/body/components-industrial.js", import.meta.url)) },
    { find: "./JsonBodyViewer.svelte", replacement: fileURLToPath(new URL("../../../../fixtures/components/body/JsonBodyViewer.svelte", import.meta.url)) },
  ] });
  try { browser = await chromium.launch(); } catch (error) { await runtime.close(); throw error; }
}, 120_000);
afterAll(async () => { try { await browser?.close(); } finally { await runtime?.close(); } });

const tabs=['original','transformed','response'];
async function withDetail(run:(page:Page)=>Promise<void>){
 const context=await browser.newContext();
 try{context.setDefaultTimeout(3000);const page=await context.newPage();const errors:string[]=[];
 page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
 await page.goto(`${runtime.origin}/tests/fixtures/components/body/index.html`);
 await page.waitForFunction(()=>typeof (window as any).start==='function');
 await run(page);expect(errors).toEqual([]);
 }finally{await context.close();}
}
for(const scenario of ['config-failed','body-disabled','missing-ids'])test(`historical body ${scenario} visits each tab once`,async()=>{
 await withDetail(async page=>{
 await page.evaluate(scenario=>{const state=window as any;state.scenario=scenario;state.start({requestId:'test',timestamp:0,method:'POST',path:'/test',status:200,duration:1,
 ...(scenario==='missing-ids'?{}:{originalReqBodyId:'original',reqBodyId:'transformed',respBodyId:'response'}),originalReqHeaderId:'original',reqHeaderId:'transformed',respHeaderId:'response'});},scenario);
 for(const tab of tabs){if(tab!=='original')await page.locator(`[data-tab="${tab}"]`).click();
 await page.waitForFunction(({tab,missing})=>{const root=document.querySelector('[data-testid="logs-detail-content"]'),body=root?.querySelector('[data-body]');return root?.textContent?.includes(`header-${tab}`)&&(missing?!body:body?.textContent?.includes(`body-${tab}`));},{tab,missing:scenario==='missing-ids'});
 }
 expect(await page.evaluate(()=>(window as any).bodyCalls)).toEqual(scenario==='missing-ids'?[]:tabs);
 });
},15000);

test('the real body tabs pass historical SSE to the rendered viewer',async()=>{
 await withDetail(async page=>{
 const expected=[{event:'named',data:{x:1}},{event:'message',data:'[DONE]'}];
 await page.evaluate(()=>{const state=window as any;state.contentType='text/event-stream';state.sseBodies=Object.fromEntries(['original','transformed','response'].map(tab=>[tab,'event: named\ndata: {"x":1}\n\ndata: [DONE]\n\n']));state.start({requestId:'sse',timestamp:0,method:'POST',path:'/test',status:200,duration:1,originalReqBodyId:'original',reqBodyId:'transformed',respBodyId:'response',originalReqHeaderId:'original',reqHeaderId:'transformed',respHeaderId:'response'});});
 for(const tab of tabs){if(tab!=='original')await page.locator(`[data-tab="${tab}"]`).click();await page.waitForFunction(({tab,expected})=>(window as any).bodyCalls.includes(tab)&&document.querySelector('[data-body]')?.textContent===JSON.stringify(expected),{tab,expected});}
 expect(await page.evaluate(()=>(window as any).bodyCalls)).toEqual(tabs);
 });
},15000);

test('opening the response first waits for final request Accept before displaying its body',async()=>{
 const body='event: named\ndata: {"x":1}\n\ndata: [DONE]\n\n';
 for(const fixture of [
 {originalAccept:'application/json',accept:'text/event-stream',media:'',body,expected:[{event:'named',data:{x:1}},{event:'message',data:'[DONE]'}]},
 {originalAccept:'text/event-stream',accept:'application/json',media:'',body,expected:body},
 {originalAccept:'text/event-stream',accept:'text/event-stream',media:'',body:'upstream failed',expected:'upstream failed'},
 {originalAccept:'text/event-stream',accept:'text/event-stream',media:'text/plain',body,expected:body},
 {originalAccept:'text/event-stream',accept:null,media:'',body,expected:[{event:'named',data:{x:1}},{event:'message',data:'[DONE]'}]},
 ])await withDetail(async page=>{
 await page.evaluate(fixture=>{const state=window as any;state.sseHeaders={original:{Accept:fixture.originalAccept,'Content-Type':'application/json'},transformed:{ACCEPT:fixture.accept,'content-type':'application/json'},response:fixture.media?{'Content-Type':fixture.media}:{}};
 state.sseBodies={original:{x:1},transformed:{x:1},response:fixture.body};state.headerGates=fixture.media?[]:[fixture.accept===null?'original':'transformed'];
 state.start({requestId:'missing-type',timestamp:0,method:'POST',path:'/test',status:200,duration:1,originalReqHeaderId:'original',...(fixture.accept===null?{}:{reqHeaderId:'transformed'}),respHeaderId:'response',respBodyId:'response'});
 },fixture);
 await page.locator('[data-tab="response"]').click();
 const header=fixture.accept===null?'original':'transformed';
 if(!fixture.media){
 await page.waitForFunction(header=>(window as any).headerCalls.includes(header),header);
 expect(await page.locator('[data-body]').count()).toBe(0);
 await page.evaluate(header=>(window as any).releaseHeader(header),header);
 }
 await page.waitForFunction(expected=>document.querySelector('[data-body]')?.textContent===JSON.stringify(expected),fixture.expected);
 expect(await page.evaluate(()=>(window as any).bodyCalls)).toEqual(['response']);
 if(fixture.media) expect(await page.evaluate(()=>(window as any).headerCalls.includes('transformed'))).toBe(false);
 });
},15000);
