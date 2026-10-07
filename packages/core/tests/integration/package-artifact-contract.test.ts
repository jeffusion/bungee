import { expect, test } from 'bun:test';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import packageManifest from '../../package.json';
import {RequestRetryAction} from '../../src/gateway/retry-action';

const packageRoot = resolve(import.meta.dir, '../..');
const dist = resolve(packageRoot, 'dist');

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

test('fresh build satisfies the published package artifact contract', async () => {
  await mkdir(resolve(dist, 'packages/core/src'), { recursive: true });
  await writeFile(resolve(dist, 'master.js'), 'stale bundle');
  await writeFile(resolve(dist, 'worker.js'), 'stale bundle');
  await writeFile(resolve(dist, 'master.d.ts'), 'stale declaration');
  await writeFile(resolve(dist, 'worker.d.ts'), 'stale declaration');
  await writeFile(resolve(dist, 'packages/core/src/stale.d.ts'), 'stale nested declaration');

  const build = Bun.spawnSync({
    cmd: [process.execPath, 'run', 'build'],
    cwd: packageRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (build.exitCode !== 0) {
    const decoder = new TextDecoder();
    throw new Error(`${decoder.decode(build.stdout)}\n${decoder.decode(build.stderr)}`);
  }

  expect(packageManifest.scripts.dev).toBe('LOG_LEVEL=debug bun --watch src/main.ts');
  expect(packageManifest.main).toBe('./dist/main.js');
  expect(Reflect.get(packageManifest, 'types')).toBe('./dist/main.d.ts');
  expect(Object.entries(packageManifest.exports)).toEqual([[
    '.', {
      types: './dist/main.d.ts',
      default: './dist/main.js',
    },
  ], [
    './plugin', {
      types:'./dist/gateway/plugin.d.ts',
      default:'./dist/gateway/plugin.js',
    },
  ]]);
  expect(packageManifest.files).toEqual(['dist','README.md']);

  const packageTargets = [
    packageManifest.main,
    Reflect.get(packageManifest, 'types'),
    packageManifest.exports['.'].types,
    packageManifest.exports['.'].default,
    packageManifest.exports['./plugin'].types,
    packageManifest.exports['./plugin'].default,
  ];
  for (const target of packageTargets) {
    expect(typeof target).toBe('string');
    if (typeof target !== 'string') throw new TypeError('package target must be a string');
    expect(target.startsWith('./')).toBeTrue();
    expect(await exists(resolve(packageRoot, target))).toBeTrue();
  }

  for (const stale of ['master.js', 'worker.js', 'packages']) {
    expect(await exists(resolve(dist, stale))).toBeFalse();
  }
  for (const rebuilt of ['master.d.ts','worker.d.ts']) {
    if (await exists(resolve(dist, rebuilt))) expect(await readFile(resolve(dist, rebuilt),'utf8')).not.toBe('stale declaration');
  }
  expect(await exists(resolve(dist, 'plugins'))).toBeTrue();
  const sdk = await import(resolve(dist, 'gateway/plugin.js'));
  expect(typeof sdk.definePlugin).toBe('function');
  expect(Reflect.get(sdk,'createBodyHandle')).toBeUndefined();
  expect(typeof sdk.createPluginHooks).toBe('function');
  expect(await exists(resolve(dist, 'gateway/body-contracts.d.ts'))).toBeTrue();
  // Bundled plugins carry their own SDK classes; declarative actions must still
  // be recognizable by the host without relying on Error.name or plain shape.
  const repairModule=await import(resolve(dist,'plugins/signature-repair/index.js'));
  const repair=new repairModule.default();const repairHooks=sdk.createPluginHooks();repair.register(repairHooks);
  const repairContext={requestId:'artifact-repair',method:'POST',body:{messages:[{role:'assistant',content:[{type:'thinking',thinking:'synthetic'}]}]}};
  await repairHooks.onBeforeRequest.promise(repairContext);
  const action=await repairHooks.onResponse.promise(Response.json({error:{message:'missing thought signature'}},{status:400}),
    {...repairContext,bodyHandle:{async json(){return {error:{message:'missing thought signature'}};}}}).catch((error:unknown)=>error);
  expect(action instanceof RequestRetryAction).toBe(true);expect(action instanceof sdk.RequestRetryAction).toBe(true);
  expect(new Error('RequestRetryAction') instanceof RequestRetryAction).toBe(false);
  expect(action.body).toEqual({messages:[{role:'assistant',content:[]}]});
  // Docker publishes dist only. Resolve the package name in that exact layout,
  // without a repository tsconfig mapping or source directories to hide errors.
  const isolated=await mkdtemp(resolve(tmpdir(),'bungee-sdk-package-'));
  try{
    const installed=resolve(isolated,'node_modules/@jeffusion/bungee-core');
    await mkdir(installed,{recursive:true});await cp(dist,resolve(installed,'dist'),{recursive:true});
    await writeFile(resolve(installed,'package.json'),JSON.stringify(packageManifest));
    await writeFile(resolve(isolated,'check.ts'),"import {definePlugin,createPluginHooks} from '@jeffusion/bungee-core/plugin'; if(typeof definePlugin!=='function'||typeof createPluginHooks!=='function')process.exit(1); console.log('sdk-package-ok');");
    const probe=Bun.spawnSync({cmd:[process.execPath,resolve(isolated,'check.ts')],cwd:isolated,stdout:'pipe',stderr:'pipe'});
    expect(new TextDecoder().decode(probe.stderr)).toBe('');expect(probe.exitCode).toBe(0);
    expect(new TextDecoder().decode(probe.stdout).trim()).toBe('sdk-package-ok');
  }finally{await rm(isolated,{recursive:true,force:true});}
}, 120_000);
