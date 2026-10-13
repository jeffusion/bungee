<script lang="ts">
  import type { ConfigurationPublication, ConfigurationRuntimeHealth } from '$api/config';
  import { _ } from '$i18n';
  import { isLoading } from 'svelte-i18n';
  let { publication, health, fresh }: { publication: ConfigurationPublication | null; health: ConfigurationRuntimeHealth | null | undefined; fresh: boolean } = $props();
  const t = (key: string) => $isLoading ? '' : $_(`settings.runtimeFacts.${key}`);
  const time = (value: number | null | undefined) => typeof value === 'number' && Number.isFinite(value) ? new Date(value).toLocaleString() : t('unavailable');
  const remaining = (value: number | null) => value === null ? t('unavailable') : `${Math.ceil(value)} ms`;
</script>

<section class="space-y-3" data-testid="runtime-facts">
  <h3 class="nx-field-label">{t('cleanup')}</h3>
  {#if fresh && publication?.cleanup}
    {@const cleanup = publication.cleanup}
    <p class="text-sm text-zinc-300" data-testid="cleanup-summary">{t(`state.${cleanup.state}`)} · {t('pending')} {cleanup.pending_count} · {t('exitUnknown')} {cleanup.exit_unknown_count} · {t('failed')} {cleanup.failed_count} · {t('unknown')} {cleanup.unknown_count}</p>
    {#if cleanup.reason_code}<p class="text-sm text-amber-300" data-testid="cleanup-reason">{t(`cleanupReason.${cleanup.reason_code}`)}</p>{/if}
    <p class="text-sm text-zinc-400" data-testid="cleanup-remaining">{t('remaining')}: {remaining(cleanup.remaining_ms)}</p>
    <ul class="space-y-1 text-sm text-zinc-300">
      {#each cleanup.members as member}
        <li>{t('slot')} {member.slot} · {t('exit')} {t(`exitState.${member.exit_state}`)} · {t('cleanup')} {t(`cleanupState.${member.cleanup_state}`)} · {t('remaining')}: {remaining(member.remaining_ms)}</li>
      {/each}
    </ul>
  {:else}<p class="text-sm text-zinc-400" data-testid="cleanup-unavailable">{t('unavailable')}</p>{/if}
  <h3 class="nx-field-label">{t('components')}</h3>
  {#if fresh && health}
    <p class="text-sm text-zinc-400">{t('observedAt')}: {time(health.observed_at)}</p>
    {#each health.component_recovery as component}
      <p class="text-sm text-zinc-300" data-testid="component-recovery">{t(`component.${component.component}`)} · {t(`state.${component.state}`)} · {t('attempt')}: {component.attempt_count ?? '—'}/{component.max_attempts ?? '—'} · {t('nextRetry')}: {component.next_retry_at === null ? t('notScheduled') : time(component.next_retry_at)}</p>
      {#if component.reason_code}<p class="font-mono text-xs text-zinc-400">{component.reason_code}</p>{/if}
    {/each}
    <h3 class="nx-field-label">{t('dependencies')}</h3>
    {#each health.dependencies as dependency}
      <p class="text-sm text-zinc-300" data-testid="runtime-dependency">{['ingress', 'config_storage', 'plugin_state', 'management_provider', 'control_plugins'].includes(dependency.component) ? t(`component.${dependency.component}`) : t('dependency')} · {t(`state.${dependency.fresh ? dependency.state : 'stale'}`)} · {t('observedAt')}: {time(dependency.observed_at)}</p>
    {/each}
  {:else}<p class="text-sm text-zinc-400" data-testid="health-unavailable">{t('unavailable')}</p>{/if}
</section>
