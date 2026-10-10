import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createGatewayFixture, type GatewayFixture } from './gateway-runtime';

export function createTokenStatsGatewayFixture(): Promise<GatewayFixture> {
  return createGatewayFixture({
    prefix: 'token-stats-gateway',
    plugins: ['token-stats', 'token-metering', 'models-dev'],
    preparePlugins: async (pluginsPath) => {
      const probePath = join(pluginsPath, 'catalog-version-probe');
      await mkdir(probePath);
      await cp(join(import.meta.dir, '../fixtures/catalog-version-probe.ts'), join(probePath, 'main.ts'));
      await writeFile(join(probePath, 'manifest.json'), JSON.stringify({
        name: 'catalog-version-probe', version: '1.0.0', schemaVersion: 3, artifactKind: 'runtime-plugin',
        capabilities: ['hooks', 'dynamicRuntimeLoad'], runtimeScope: 'global', main: 'main.ts',
        uiExtensionMode: 'none', engines: { bungee: '^5.0.0' }, configSchema: [], dependencies: { 'models-dev': '^1.0.0' },
        services: { consumes: [{ plugin: 'models-dev', id: 'models-dev.catalog.v1', version: 1, process: 'worker' }] },
      }));
    },
  });
}
