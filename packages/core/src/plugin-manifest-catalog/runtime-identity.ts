import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';

export type RuntimeIdentityInput = Readonly<{
  path: string;
  bytes: Uint8Array;
}>;

export function normalizeRuntimeIdentity(pluginRoot: string, inputPath: string): string {
  const root = resolve(pluginRoot);
  const input = isAbsolute(inputPath) ? resolve(inputPath) : resolve(root, inputPath);
  const identity = relative(root, input) || '.';
  return identity.replaceAll('\\', '/');
}

export function hashRuntimeIdentity(
  pluginRoot: string,
  inputs: Iterable<RuntimeIdentityInput>,
  externalDependencies: Iterable<string> = [],
): `sha256:${string}` {
  const normalizedInputs = [...inputs]
    .map(({ path, bytes }) => ({ identity: normalizeRuntimeIdentity(pluginRoot, path), bytes }))
    .sort((left, right) => left.identity.localeCompare(right.identity));
  const hash = createHash('sha256');
  for (const { identity, bytes } of normalizedInputs) {
    hash.update(identity);
    hash.update('\0');
    hash.update(bytes);
    hash.update('\0');
  }
  for (const dependency of [...new Set(externalDependencies)].sort()) {
    hash.update(`external\0${dependency}\0`);
  }
  return `sha256:${hash.digest('hex')}`;
}
