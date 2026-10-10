import { logger } from '@jeffusion/bungee-core/plugin';
import type { ControlHostContext, PluginControl, ControlPlugin } from '@jeffusion/bungee-core/plugin';
import { MODELS_DEV_CAPABILITIES_SERVICE_ID, MODELS_DEV_CAPABILITIES_CONTRACT_VERSION, type ModelsDevCapabilitiesService } from '../../models-dev/contract';
import { historyRpc, CONVERSION_SERVICE_ID, CONVERSION_VERSION } from '../contract';
import { HistoryTransport } from './history';
import { conversionService } from './service';
export function createControl(host: ControlHostContext): PluginControl {
    const catalog = host.services!.consume<ModelsDevCapabilitiesService>('models-dev', MODELS_DEV_CAPABILITIES_SERVICE_ID, MODELS_DEV_CAPABILITIES_CONTRACT_VERSION);
    host.services!.publish(CONVERSION_SERVICE_ID, CONVERSION_VERSION, conversionService(catalog, false));
    const history = new HistoryTransport(), timer = setInterval(() => history.sweep(), 30000);
    timer.unref?.();
    const dispose = () => { clearInterval(timer); history.clear(); };
    host.signal.addEventListener('abort', dispose, { once: true });
    host.services!.rpc!.publish(historyRpc, { get: input => history.get(input), put: input => { try {
            return history.put(input);
        }
        catch (error) {
            const code = error instanceof Error && /^llm_adapter_history_[a-z_]+$/.test(error.message) ? error.message : 'llm_adapter_history_failure';
            logger.error({ code, index: input.index, total: input.total }, 'llm_adapter_history_rejected');
            throw error;
        } } });
    return { rpc: [], start() { }, async dispose() { dispose(); } };
}
export default { createControl } satisfies ControlPlugin;
