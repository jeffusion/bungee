<script lang="ts">
  import { publicationRecovery, publicationInProgress } from '$stores/runtime';
  import { _ } from '$i18n';
  import { isLoading } from 'svelte-i18n';
  import { SystemAlertBar } from '$components/industrial';

  const publication = $derived($publicationRecovery.publication);
  const active = $derived(publicationInProgress(publication));
  const degraded = $derived(publication?.operation?.state === 'degraded');
</script>

{#if !$isLoading && publication && (active || degraded)}
  <div role="status" aria-live="polite" data-testid="configuration-publication-banner">
    <SystemAlertBar tone={degraded || !$publicationRecovery.fresh ? 'warn' : 'info'}>
      <p class="text-sm text-zinc-200">
        {$_(!$publicationRecovery.fresh ? 'configurationSave.statusUnavailable'
          : degraded ? 'configurationSave.degraded'
          : publication.operation?.state === 'draining' && publication.serving_complete
            ? 'configurationSave.draining' : 'configurationSave.publishing')}
      </p>
      <a slot="action" href="/#/config" class="nx-btn-ghost">{$_('configurationSave.details')}</a>
    </SystemAlertBar>
  </div>
{/if}
