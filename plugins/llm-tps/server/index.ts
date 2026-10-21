import { definePlugin, TOKEN_METERING_CONTRACT_VERSION, TOKEN_METERING_SERVICE_ID,
  type Plugin, type PluginHooks, type PluginInitContext, type TokenMeteringService } from '@jeffusion/bungee-core/plugin';
import { TPS_REPORTING_INCOMPLETE_KEY } from '../contract';
import { sampleFromResult } from './metrics';
import { observationClient } from './storage';

const MAX_PENDING = 256;

export const LlmTpsPlugin = definePlugin(class implements Plugin {
  static readonly name = 'llm-tps';
  static readonly version = '1.0.0';
  private unsubscribe?: () => void;
  private accepting = false;
  private pending = 0;
  private writes: Promise<void> = Promise.resolve();
  private reportingWrite?: Promise<void>;
  private reportingPersisted = false;

  bodyRequirements() { return { request: 'none' } as const; }
  register(_hooks: PluginHooks): void {}

  async init(context: PluginInitContext): Promise<void> {
    if (context.scope?.type !== 'route' || !context.scope.routeId?.trim()) throw new Error('llm-tps requires a route binding');
    if (!context.services) throw new Error('llm-tps requires token-metering service');
    const client = observationClient(context.storage);
    const storage = context.storage.uncached?.() ?? context.storage;
    const metering = context.services.consume<TokenMeteringService>('token-metering', TOKEN_METERING_SERVICE_ID, TOKEN_METERING_CONTRACT_VERSION);
    const routeId = context.scope.routeId;
    const incomplete = () => {
      if (this.reportingPersisted || this.reportingWrite) return;
      this.reportingWrite = Promise.resolve().then(() => storage.set(TPS_REPORTING_INCOMPLETE_KEY, true)).then(() => {
        this.reportingPersisted = true;
      }).catch(() => {
        try { context.logger.error('llm-tps could not persist incomplete reporting status'); } catch {}
      }).finally(() => { this.reportingWrite = undefined; });
    };
    this.accepting = true;
    this.unsubscribe = metering.subscribe({
      onResult: result => {
        if (!this.accepting || result.routeId !== routeId) return;
        try {
          if (result.observationIncomplete && result.generationDurationMs === undefined) incomplete();
          const sample = sampleFromResult(result, routeId);
          if (!sample) return;
          if (this.pending >= MAX_PENDING) { incomplete(); return; }
          this.pending++;
          this.writes = this.writes.then(() => client.recordSample(sample)).catch(incomplete).finally(() => { this.pending--; });
        } catch { incomplete(); }
      },
      onFailure: (_error, result) => { if (this.accepting && result.routeId === routeId) incomplete(); },
    });
    context.services.onDispose(() => this.stopAccepting());
  }

  private stopAccepting(): void {
    this.accepting = false;
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = undefined;
    unsubscribe?.();
  }

  async onDestroy(): Promise<void> {
    this.stopAccepting();
    await this.writes;
    await this.reportingWrite;
  }
});

export default LlmTpsPlugin;
