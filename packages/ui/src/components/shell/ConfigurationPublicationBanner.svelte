<script lang="ts">
  import { publicationRecovery, publicationInProgress } from '$stores/runtime';
  import { _ } from '$i18n';
  import { isLoading } from 'svelte-i18n';
  import { SystemAlertBar } from '$components/industrial';
  import { publicationMessage, historicalDrainFailure, runtimeHealthFault } from '$components/domain/config/publication-state';

  const publication = $derived($publicationRecovery.publication);
  const active = $derived(publicationInProgress(publication) || publication?.cleanup?.active === true);
  const degraded = $derived(publication?.operation?.state === 'degraded' && !historicalDrainFailure(publication, $publicationRecovery.fresh));
  const dependencyFault = $derived(runtimeHealthFault($publicationRecovery.runtime?.health, $publicationRecovery.fresh));
</script>

{#if !$isLoading && publication && (active || degraded || dependencyFault)}
  <div role="status" aria-live="polite" data-testid="configuration-publication-banner">
    <SystemAlertBar tone={degraded || dependencyFault || !$publicationRecovery.fresh ? 'warn' : 'info'}>
      <p class="text-sm text-zinc-200">
        {$_(`configurationSave.${dependencyFault ? 'runtimeBlocked' : publicationMessage(publication, $publicationRecovery.fresh)}`)}
      </p>
      <a slot="action" href="/#/config" class="nx-btn-ghost">{$_('configurationSave.details')}</a>
    </SystemAlertBar>
  </div>
{/if}
