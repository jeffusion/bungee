import { PluginServiceHost } from '../../src/plugin-services';
import { HostChannelAdapter } from '../../src/plugin-services/channels';
import { PluginPeerChannelHub } from '../../src/plugin-services/peer-channel-hub';

/** Real worker service lifecycle with an explicitly unavailable catalog peer. */
export function emptyCatalogServiceHost(): PluginServiceHost {
  const hub = new PluginPeerChannelHub({
    process: 'worker', peerProcess: 'control',
    resolveRoute: () => ({ kind: 'unavailable' }), authorizeInbound: () => false,
  });
  const channels = new HostChannelAdapter({ hub, process: 'worker', remoteTransport: () => false });
  return new PluginServiceHost('worker', {
    identity: (plugin, scope) => ({ endpoint: `transformer:${plugin}:${scope}`, instance: 'transformer-fixture', generation: 1, catalog: 'fixture-catalog', subject: plugin }),
    resolvePlacement: () => null, resolveJournal: () => null, resolveCallee: () => null,
    channels: input => channels.createOwner(input),
  });
}
