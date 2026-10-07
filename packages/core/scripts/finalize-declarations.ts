import { cp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const packageRoot = resolve(import.meta.dir, '..');
const declarations = resolve(packageRoot, '.declarations');
// Public SDK declarations refer to other public types: preserve their relative layout.
await cp(declarations, resolve(packageRoot, 'dist'), { recursive: true });
await rm(declarations, { recursive: true, force: true });
