import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const MASTER_COMPOSITION_CONTROL_A = 'master-composition-control-a';
export const MASTER_COMPOSITION_CONTROL_B = 'master-composition-control-b';

export async function writeMasterCompositionControls(root: string, auditPath: string): Promise<string> {
  const pluginsPath = join(root, 'plugins');
  for (const name of [MASTER_COMPOSITION_CONTROL_A, MASTER_COMPOSITION_CONTROL_B]) {
    const pluginPath = join(pluginsPath, name);
    await mkdir(pluginPath, { recursive: true });
    await writeFile(join(pluginPath, 'manifest.json'), JSON.stringify({
      name,
      version: '1.0.0',
      schemaVersion: 2,
      artifactKind: 'runtime-plugin',
      main: 'main.ts',
      control: { entry: 'control.ts', rpc: [{ name: 'noop', access: 'bound-attempt' }] },
      capabilities: ['hooks', 'controlPlane', 'dynamicRuntimeLoad'],
      uiExtensionMode: 'none',
      engines: { bungee: '^4.3.0' },
      configSchema: [],
    }) + '\n', 'utf8');
    await writeFile(join(pluginPath, 'main.ts'), 'export default {};\n', 'utf8');
    await writeFile(join(pluginPath, 'control.ts'), `import { appendFileSync } from 'node:fs';
export function createControl() {
  appendFileSync(${JSON.stringify(auditPath)}, ${JSON.stringify(`${name}\n`)});
  return { api: [], rpc: [{ name: 'noop', handler: 'noop', invoke: async () => null }], start() {}, dispose() {} };
}
`, 'utf8');
  }
  return pluginsPath;
}
