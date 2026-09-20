<script lang="ts">
  import { _, isLoading } from '$i18n';
  import { findRuntimeUpstream, runtimeStatus } from '$api/runtime';
  import { runtimeUpstreams } from '$stores/runtime';
  import { StatusBadge } from '$components/industrial';

  let { stateKey, upstream }: { stateKey: string; upstream: { _uid?: string; is_disabled?: boolean } } = $props();
  const record = $derived(findRuntimeUpstream($runtimeUpstreams, stateKey, upstream._uid));
  const status = $derived(runtimeStatus[record?.circuit_state ?? 'UNKNOWN']);
</script>

{#if !$isLoading}
  <StatusBadge variant={upstream.is_disabled ? 'muted' : status.badge} dot>
    {$_(upstream.is_disabled ? 'upstream.disabled' : status.key)}
  </StatusBadge>
{/if}
