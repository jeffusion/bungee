<script lang="ts">
  import type { ServiceTimeoutsConfig } from '$types';
  import { Input } from '$components/ui/input';
  import { _ } from '$i18n';

  export let timeouts: ServiceTimeoutsConfig | undefined;

  let connectMs: number | undefined;
  let sendMs: number | undefined;
  let readMs: number | undefined;
  let initialized = false;

  function initializeFromProps() {
    connectMs = timeouts?.connect_ms;
    sendMs = timeouts?.send_ms;
    readMs = timeouts?.read_ms;
  }

  function compactObject<T extends Record<string, any>>(value: T): T | undefined {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    return entries.length > 0 ? (Object.fromEntries(entries) as T) : undefined;
  }

  function syncModel() {
    timeouts = compactObject({
      connect_ms: connectMs,
      send_ms: sendMs,
      read_ms: readMs,
    });
  }

  $: if (!initialized) {
    initializeFromProps();
    initialized = true;
  }
</script>

<div class="space-y-4" data-testid="service-timeouts-section">
  <div class="flex items-center gap-2">
    <svg viewBox="0 0 24 24" class="h-4 w-4 text-nexus-400" fill="none" stroke="currentColor" stroke-width="1.8">
      <path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
    <span class="font-mono text-[11px] uppercase tracking-command text-zinc-200">{$_('serviceEditor.timeouts.title')}</span>
  </div>

  <p class="text-xs text-zinc-500">{$_('serviceEditor.timeouts.help')}</p>

  <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
    <div class="space-y-1.5">
      <label class="block" for="service-connect-ms">
        <span class="nx-label-sm">{$_('serviceEditor.timeouts.connectMs')}</span>
      </label>
      <Input
        id="service-connect-ms"
        type="number"
        placeholder="5000"
        value={connectMs ?? ''}
        oninput={(e) => { connectMs = (e.target as HTMLInputElement).value ? Number((e.target as HTMLInputElement).value) : undefined; syncModel(); }}
        min="100"
      />
    </div>

    <div class="space-y-1.5">
      <label class="block" for="service-send-ms">
        <span class="nx-label-sm">{$_('serviceEditor.timeouts.sendMs')}</span>
      </label>
      <Input
        id="service-send-ms"
        type="number"
        placeholder="30000"
        value={sendMs ?? ''}
        oninput={(e) => { sendMs = (e.target as HTMLInputElement).value ? Number((e.target as HTMLInputElement).value) : undefined; syncModel(); }}
        min="100"
      />
    </div>

    <div class="space-y-1.5">
      <label class="block" for="service-read-ms">
        <span class="nx-label-sm">{$_('serviceEditor.timeouts.readMs')}</span>
      </label>
      <Input
        id="service-read-ms"
        type="number"
        placeholder="30000"
        value={readMs ?? ''}
        oninput={(e) => { readMs = (e.target as HTMLInputElement).value ? Number((e.target as HTMLInputElement).value) : undefined; syncModel(); }}
        min="100"
      />
    </div>
  </div>
</div>
