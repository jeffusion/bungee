import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

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
