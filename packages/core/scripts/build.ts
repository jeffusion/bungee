import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pluginRuntimeBuildSource } from '../src/plugin-manifest-catalog/runtime-identity';

const packageRoot = resolve(import.meta.dir, '..');
const outputDirectory = resolve(packageRoot, 'dist');

await rm(outputDirectory, { recursive: true, force: true });

const build = Bun.spawn({
  cmd: [
    process.execPath,
    'build',
    'src/main.ts',
    '--outdir',
    outputDirectory,
    '--target',
    'bun',
  ],
  cwd: packageRoot,
  stdout: 'inherit',
  stderr: 'inherit',
});

const exitCode = await build.exited;
if (exitCode !== 0) {
  throw new Error(`core bundle build failed with exit code ${exitCode}`);
}

// Compile the public SDK separately: the host registers file transports, while
// independently bundled plugins forward logs to its shared process sink.
const sdkBuild = await Bun.build({
  entrypoints: [resolve(packageRoot, 'src/gateway/plugin.ts')],
  outdir: resolve(outputDirectory, 'gateway'),
  naming: 'plugin.js', target: 'bun', format: 'esm',
  plugins: [{ name: 'bungee-public-sdk-log-sink', setup(builder) {
    builder.onLoad({ filter: /[/\\]logger\.ts$/ }, ({ path }) => {
      const contents = pluginRuntimeBuildSource(path);
      return contents === undefined ? undefined : { contents, loader: 'ts' };
    });
  } }],
});
if (!sdkBuild.success) throw new Error(`public plugin SDK build failed: ${sdkBuild.logs.join('\n')}`);

// Storage leaves are explicit distribution artifacts; URLs never resolve into absent src/.
for (const [entry, name] of [['src/config-storage/storage-worker.ts','config-storage-worker.js'],['src/plugin-state/worker.ts','plugin-state-worker.js'],['src/master-runtime/observability-worker.ts','observability-worker.js']] as const) {
  const worker = Bun.spawn({cmd:[process.execPath,'build',entry,'--outfile',resolve(outputDirectory,name),'--target','bun'],cwd:packageRoot,stdout:'inherit',stderr:'inherit'});
  if(await worker.exited!==0)throw new Error(`storage worker build failed: ${name}`);
}
