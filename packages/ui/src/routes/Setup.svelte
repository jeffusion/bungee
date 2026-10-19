<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { get } from 'svelte/store';
  import { _ } from '$i18n';
  import { authMode } from '$stores/auth';
  import { getNativeWidget, hasManagementSetupComponent, hasManagementLoginComponent } from '$components/native-widgets';
  import { createManagementSetupContext } from '$api/management-setup';
  import { registerStaticPluginTranslations } from '$i18n/plugin-translations';
  import { PanelCard, LoadingIndicator } from '$components/industrial';

  let { onCompleted }: { onCompleted: () => void } = $props();
  let pageError = $state(''), ready = $state(false);
  let instance = $state.raw<ReturnType<typeof createManagementSetupContext> | null>(null);
  let destroyed = false;
  const providerIdentity = $derived(JSON.stringify([
    $authMode?.mode, $authMode?.provider?.name, $authMode?.publicOrigin,
    $authMode?.provider?.setupComponent, $authMode?.provider?.loginComponent,
  ]));
  const ProviderSetup = $derived($authMode?.mode === 'plugin' && $authMode.provider
    && hasManagementSetupComponent($authMode.provider.name, $authMode.provider.setupComponent)
    && hasManagementLoginComponent($authMode.provider.name, $authMode.provider.loginComponent)
    ? getNativeWidget($authMode.provider.setupComponent!) : null);

  async function check(owned: ReturnType<typeof createManagementSetupContext>) {
    pageError = ''; ready = false;
    try {
      const initialized = await owned.check();
      if (!destroyed && instance === owned) ready = !initialized;
    } catch {
      if (!destroyed && instance === owned) pageError = 'management.stateUnavailable';
    }
  }

  $effect(() => {
    providerIdentity;
    if (!ProviderSetup) return;
    const owned = untrack(() => {
      pageError = ''; ready = false;
      const mode = get(authMode);
      if (!mode?.provider || !mode.publicOrigin) { pageError = 'management.providerUnavailable'; return null; }
      registerStaticPluginTranslations(mode.provider.name);
      try {
        return createManagementSetupContext({
          provider: { name: mode.provider.name, publicOrigin: mode.publicOrigin },
          onCompleted: () => { if (!destroyed) onCompleted(); },
        });
      } catch { pageError = 'management.stateUnavailable'; return null; }
    });
    instance = owned;
    if (owned) void check(owned);
    return () => { owned?.dispose(); instance = null; };
  });
  onDestroy(() => { destroyed = true; instance?.dispose(); });
</script>

<div data-testid="page-setup" class="min-h-screen flex items-center justify-center p-4 bg-carbon-950 nx-grid-bg">
  <div class="w-full max-w-md">
    <PanelCard title={$_('management.setupTitle')} tag="BUNGEE">
      <div class="px-4 py-6 space-y-5">
        <h1 class="nx-display text-xl text-zinc-50">{$_('management.setupTitle')}</h1>
        {#if pageError}<p role="alert" class="text-sm text-red-400">{$_(pageError)}</p>
          {#if instance}<button class="nx-btn-ghost" onclick={() => instance && void check(instance)}>{$_('common.refresh')}</button>{/if}
        {:else if !ProviderSetup}<p role="alert" class="text-sm text-zinc-400">{$_('management.setupComponentUnavailable')}</p>
        {:else if ready && instance}
          {#key instance.context}<ProviderSetup context={instance.context} />{/key}
        {:else}<LoadingIndicator label={$_('common.loading')} size="xs" />{/if}
        <div class="space-y-2 text-sm text-zinc-400">
          <p>{$_('management.setupRecovery')}</p>
        </div>
      </div>
    </PanelCard>
  </div>
</div>
