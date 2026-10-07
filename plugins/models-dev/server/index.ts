/**
 * models-dev worker instance.
 *
 * It consumes the control provider's authenticated, verified snapshot. The Host
 * reconciles it in the background; request-time lookups only use the local index.
 */

import type { Plugin } from '@jeffusion/bungee-core/plugin';
import { definePlugin } from '@jeffusion/bungee-core/plugin';
import type { PluginHooks, PluginInitContext, PluginLogger } from '@jeffusion/bungee-core/plugin';
import { MODELS_DEV_CATALOG_CONTRACT_VERSION, MODELS_DEV_CATALOG_SERVICE_ID, MODELS_DEV_CATALOG_SNAPSHOT_CONTRACT } from '../contract';
import { CatalogView, catalogServiceOf, reconcileCatalogView } from './local';

const RECONCILE_INTERVAL_MS = 5_000;

export const ModelsDevPlugin = definePlugin(
  class implements Plugin {
    static readonly name = 'models-dev';
    static readonly version = '1.0.0';
    logger!: PluginLogger;
    private readonly view = new CatalogView();
    private cleanup: (() => void) | undefined;

    async init(context: PluginInitContext): Promise<void> {
      this.logger = context.logger;
      const services = context.services;
      if (services?.snapshot === undefined) throw new Error('models-dev requires the snapshot service context');
      const snapshot = services.snapshot.consume('models-dev', MODELS_DEV_CATALOG_SNAPSHOT_CONTRACT);
      const apply = (current: ReturnType<typeof snapshot.current>) => {
        if (reconcileCatalogView(current, this.view) === 'failed') this.logger.warn('models-dev catalog snapshot is unavailable');
      };
      const unsubscribe = snapshot.onApplied(apply);
      await snapshot.sync();
      if (this.view.status().version === null) apply(snapshot.current());
      const local = catalogServiceOf(this.view);
      services.publish(MODELS_DEV_CATALOG_SERVICE_ID, MODELS_DEV_CATALOG_CONTRACT_VERSION, {
        ...local,
        status: () => {
          const status = local.status(), transport = snapshot.status();
          return transport.status === 'failed' || transport.status === 'stale'
            ? { ...status, state: status.version === null ? 'failed' as const : 'stale' as const, error: transport.error }
            : status;
        },
      });
      const stop = snapshot.start({ intervalMs: RECONCILE_INTERVAL_MS });
      this.cleanup = () => { unsubscribe(); stop(); };
      services.onDispose(() => this.stopTimer());
      this.logger.info('models-dev worker catalog view initialized');
    }

    bodyRequirements() { return { request: 'none' as const }; }

    register(_hooks: PluginHooks): void {}

    async onDestroy(): Promise<void> {
      this.stopTimer();
      this.logger?.info('models-dev worker destroyed');
    }

    private stopTimer(): void {
      this.cleanup?.();
      this.cleanup = undefined;
    }
  },
);

export default ModelsDevPlugin;
