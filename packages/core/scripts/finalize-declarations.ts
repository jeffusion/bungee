import { copyFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const packageRoot = resolve(import.meta.dir, '..');
const declarations = resolve(packageRoot, '.declarations');

await copyFile(resolve(declarations, 'main.d.ts'), resolve(packageRoot, 'dist/main.d.ts'));
await rm(declarations, { recursive: true, force: true });
