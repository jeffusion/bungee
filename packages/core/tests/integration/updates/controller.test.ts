import { afterEach, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UpdateController } from '../../../src/updates/controller';
import { getAssetName, getBinaryName } from '../../../src/updates/names';
import { selectedVersion } from '../../../src/updates/installation';
import { RELEASE_API } from '../../../src/updates/release';

const roots: string[] = [];
const controllers: UpdateController[] = [];
afterEach(async () => { for (const controller of controllers.splice(0)) { controller.cancel(); await controller.wait(); } for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(options: { restart?: (activate: () => string, token: string, signal: AbortSignal) => Promise<void>; corrupt?: boolean; rejectDownload?: boolean; checkGate?: Promise<void>; admit?:()=>Promise<void> } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bungee-updates-')); roots.push(root);
  const binary = getBinaryName(), asset = getAssetName();
  for (const version of ['1.0.0','1.1.0']) {
    const directory = join(root, version === '1.0.0' ? 'bin' : 'fixture', version);
    mkdirSync(join(directory, 'plugins','example'), { recursive: true });
    writeFileSync(join(directory,binary), `#!/bin/sh\nprintf '${version}\\n'\n`); chmodSync(join(directory,binary),0o755);
    writeFileSync(join(directory,'plugins','example','manifest.json'),'{}');
    writeFileSync(join(directory,'plugins','example','index.js'),'export default {}');
  }
  writeFileSync(join(root,'version.txt'),'1.0.0\n');
  const archive = join(root,'release.tar.gz');
  const packed = Bun.spawnSync(['tar','-czf',archive,'-C',join(root,'fixture','1.1.0'),binary,'plugins']);
  if (packed.exitCode !== 0) throw new Error(packed.stderr.toString());
  const bytes = readFileSync(archive);
  const url = `https://github.com/jeffusion/bungee/releases/download/v1.1.0/${asset}`;
  const metadata = { tag_name:'v1.1.0',draft:false,prerelease:false,published_at:'2026-10-26T00:00:00Z',
    html_url:'https://github.com/jeffusion/bungee/releases/tag/v1.1.0',assets:[{name:asset,state:'uploaded',size:bytes.length,
      digest:`sha256:${createHash('sha256').update(bytes).digest('hex')}`,browser_download_url:url}] };
  const calls = { checks:0, downloads:0 };
  const http = (async (input: string | URL | Request) => {
    if (String(input) === RELEASE_API) { calls.checks++; await options.checkGate; return Response.json(metadata); }
    if (String(input) === url) { calls.downloads++; if (options.rejectDownload) return new Response('unavailable',{status:503}); return new Response(options.corrupt ? Buffer.alloc(bytes.length) : bytes); }
    throw new Error(`Unexpected update URL: ${input}`);
  }) as typeof fetch;
  const controller = new UpdateController({ version:'1.0.0', root, compiled:true, executable:join(root,'bin','1.0.0',binary),http,
    restart:options.restart,admit:options.admit });
  controllers.push(controller);
  const request = {operation_id:randomUUID(),current_version:'1.0.0',target_version:'1.1.0'};
  return {root,controller,calls,request,metadata};
}

test('checks and reads never download; explicit installation is idempotent across responses', async () => {
  const {root,controller,calls,request} = fixture();
  await controller.check(); controller.status();
  expect(calls).toEqual({checks:1,downloads:0}); expect(selectedVersion(root)).toBe('1.0.0');
  const accepted = await Promise.all([controller.request(request),controller.request(request)]);
  expect(accepted.map(status=>status.operation?.id)).toEqual([request.operation_id,request.operation_id]);
  expect(accepted[0]!.operation?.phase).toBe('downloading');
  expect((await controller.request(request)).operation?.id).toBe(request.operation_id);
  expect((await controller.wait()).operation?.phase).toBe('succeeded');
  expect(selectedVersion(root)).toBe('1.1.0');
  await controller.request(request); expect(calls.downloads).toBe(1);
});

async function downloaded(controller: UpdateController): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (controller.status().operation?.phase !== 'awaiting_confirmation' && performance.now() < deadline) await Bun.sleep(10);
  expect(controller.status().operation?.phase).toBe('awaiting_confirmation');
}

test('browser downloads wait for a matching second confirmation; duplicate confirmation installs once', async () => {
  let restarts=0;
  const {controller,request,root,calls}=fixture({restart:async activate=>{restarts++;activate();}});
  const endpoint='http://localhost/api/system/updates';
  const post=(suffix:string,body:unknown=request,origin='http://localhost')=>controller.handle(new Request(endpoint+suffix,
    {method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)}));
  expect((await post('')).status).toBe(202);
  await downloaded(controller);
  expect(selectedVersion(root)).toBe('1.0.0');expect(restarts).toBe(0);expect(calls.downloads).toBe(1);
  expect((await controller.request(request)).operation?.phase).toBe('awaiting_confirmation');
  expect((await post('/confirm',{...request,target_version:'2.0.0'})).status).toBe(409);
  expect((await post('/confirm',request,'https://other.example')).status).toBe(403);
  expect((await Promise.all([post('/confirm'),post('/confirm')])).map(response=>response.status)).toEqual([202,202]);
  await controller.wait();expect(restarts).toBe(1);expect(selectedVersion(root)).toBe('1.1.0');
  expect((await post('/confirm')).status).toBe(202);expect(restarts).toBe(1);
});

test('stopping while awaiting confirmation cancels the staged download without activating it', async () => {
  let restarts=0;
  const {controller,request,root}=fixture({restart:async()=>{restarts++;}});
  await controller.request(request,true);await downloaded(controller);controller.cancel();
  expect((await controller.wait()).operation?.phase).toBe('cancelled');
  expect(restarts).toBe(0);expect(selectedVersion(root)).toBe('1.0.0');expect(existsSync(join(root,'update.lock'))).toBe(false);
});

test('invalid identities, concurrent operations and unready release assets never replace the selected version', async () => {
  const {controller,calls,request,metadata,root} = fixture();
  await controller.check();
  await expect(controller.request({...request,target_version:'2.0.0'})).rejects.toThrow('version_conflict');
  await expect(controller.request({...request,download_url:'https://other.example'} as any)).rejects.toThrow('invalid_request');
  metadata.assets=[]; await controller.check();
  await expect(controller.request(request)).rejects.toThrow('asset_not_ready');
  expect(calls.downloads).toBe(0); expect(selectedVersion(root)).toBe('1.0.0');
});

test('digest failure leaves executable, plugins and selected version untouched', async () => {
  const {root,controller,request} = fixture({corrupt:true});
  await controller.check(); await controller.request(request);
  expect((await controller.wait()).operation).toMatchObject({phase:'failed',error:'digest_mismatch'});
  expect(selectedVersion(root)).toBe('1.0.0'); expect(existsSync(join(root,'bin','1.1.0'))).toBe(false);
});

test('unconfirmed shutdown stops before activation and never falls back to force killing', async () => {
  let attempts=0;
  const {root,controller,request}=fixture({restart:async()=>{attempts++;throw new Error('cleanup unconfirmed');}});
  await controller.check(); await controller.request(request);
  expect((await controller.wait()).operation).toMatchObject({phase:'failed',error:'shutdown_failed'});
  expect(attempts).toBe(1); expect(selectedVersion(root)).toBe('1.0.0');
});

test('a second operation is rejected and cancellation prevents activation', async () => {
  let activate:()=>string=()=>{throw new Error('not reached');};
  let release!:()=>void;
  const held=new Promise<void>(resolve=>release=resolve);
  const {controller,request,root}=fixture({restart:async next=>{activate=next;await held;activate();}});
  await controller.check();await controller.request(request);
  await expect(controller.request({...request,operation_id:randomUUID()})).rejects.toThrow('update_busy');
  controller.cancel();release();
  expect((await controller.wait()).operation?.phase).toBe('cancelled');expect(selectedVersion(root)).toBe('1.0.0');
});

test('failure after activation retains the selected target and never silently downgrades', async () => {
  const {controller,request,root}=fixture({restart:async activate=>{activate();throw new Error('new startup failed');}});
  await controller.check();await controller.request(request);
  expect((await controller.wait()).operation).toMatchObject({phase:'failed',error:'startup_failed'});
  expect(selectedVersion(root)).toBe('1.1.0');expect(existsSync(join(root,'bin','1.0.0'))).toBe(true);
});

test('stop while awaiting release metadata prevents acquiring an update or downloading', async () => {
  let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
  const {controller,request,calls,root}=fixture({checkGate:gate});
  const pending=controller.request(request);
  controller.cancel();release();
  await expect(pending).rejects.toThrow('update_cancelled');
  expect(calls.downloads).toBe(0);expect(existsSync(join(root,'update.lock'))).toBe(false);expect(selectedVersion(root)).toBe('1.0.0');
});

test('stop while awaiting admission is not lost when the operation is initialized', async () => {
  let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
  const {controller,request,calls,root}=fixture({admit:()=>gate});
  await controller.check();const pending=controller.request(request);
  expect(existsSync(join(root,'update.lock'))).toBe(true);
  controller.cancel();release();
  await expect(pending).rejects.toThrow('update_cancelled');
  expect(calls.downloads).toBe(0);expect(existsSync(join(root,'update.lock'))).toBe(false);expect(selectedVersion(root)).toBe('1.0.0');
});

test('source runtimes still report releases but reject page upgrade and cross-origin writes', async () => {
  const {controller,request,calls}=fixture();
  expect((await controller.handle(new Request('http://localhost/api/system/updates', {method:'POST',headers:{origin:'https://other.example'},body:JSON.stringify(request)}))).status).toBe(403);
  const source=new UpdateController({version:'1.0.0',compiled:false});
  expect(source.status().unavailable_reason).toBe('source_runtime');
  await expect(source.request(request)).rejects.toThrow('source_runtime'); expect(calls.downloads).toBe(0);
});
