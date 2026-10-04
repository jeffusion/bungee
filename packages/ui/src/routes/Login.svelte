<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { get } from 'svelte/store';
  import { _ } from '$i18n';
  import { authMode } from '$stores/auth';
  import { getNativeWidget, hasManagementLoginComponent } from '$components/native-widgets';
  import { createManagementLoginContext } from '$api/management-login';
  import { registerStaticPluginTranslations } from '$i18n/plugin-translations';
  import { PanelCard } from '$components/industrial';

  interface Props {
    onAuthenticated: (currentGuard: () => boolean) => Promise<boolean>;
    onCompleted: () => void;
    onRefresh: () => Promise<boolean>;
  }

  let { onAuthenticated, onCompleted, onRefresh }: Props = $props();
  let pageError = $state('');
  let refreshing = $state(false);
  let contextReady = $state(true);
  let instance = $state.raw<ReturnType<typeof createManagementLoginContext> | null>(null);
  let destroyed = false;
  const providerIdentity = $derived($authMode?.mode === 'plugin'
    ? JSON.stringify([$authMode.provider?.name, $authMode.publicOrigin, $authMode.provider?.loginComponent]) : '');
  const ProviderLogin = $derived($authMode?.mode === 'plugin' && $authMode.provider
    && hasManagementLoginComponent($authMode.provider.name, $authMode.provider.loginComponent)
    ? getNativeWidget($authMode.provider.loginComponent!) : null);

  $effect(() => {
    providerIdentity;
    if (refreshing || !contextReady || !ProviderLogin) return;
    const owned = untrack(() => {
      const mode = get(authMode);
      pageError = '';
      if (mode?.mode !== 'plugin' || !mode.provider?.name || !mode.publicOrigin) {
        pageError = 'management.providerUnavailable';
        return null;
      }
      registerStaticPluginTranslations(mode.provider.name);
      try {
        return createManagementLoginContext({
          provider: { name: mode.provider.name, publicOrigin: mode.publicOrigin },
          onAuthenticated: (currentGuard: () => boolean) => onAuthenticated(currentGuard),
          onCompleted: () => { if (!destroyed) onCompleted(); },
        });
      } catch {
        pageError = 'management.providerUnavailable';
        return null;
      }
    });
    instance = owned;
    return () => { owned?.dispose(); instance = null; };
  });

  onDestroy(() => { destroyed = true; instance?.dispose(); });
  async function refresh() {
    if (refreshing) return;
    instance?.dispose();
    instance = null;
    contextReady = false;
    refreshing = true;
    pageError = '';
    try {
      const ready = await onRefresh();
      if (!destroyed) {
        contextReady = ready;
        if (!ready) pageError = 'management.stateUnavailable';
      }
    } catch {
      if (!destroyed) pageError = 'management.stateUnavailable';
    } finally {
      if (!destroyed) refreshing = false;
    }
  }
</script>

<div data-testid="page-login" class="min-h-screen flex items-center justify-center p-4 bg-carbon-950 nx-grid-bg relative overflow-hidden">
  <div class="relative w-full max-w-md">
    <PanelCard title={$_('management.loginTitle')} tag="BUNGEE">
      <div class="px-4 py-6 space-y-6">
        <!-- Brand -->
        <div class="flex flex-col items-center gap-3">
          <span class="relative flex h-14 w-14 items-center justify-center border border-nexus-500/60 bg-carbon-900">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              class="h-7 w-7 text-nexus-500"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              stroke-width="2"
            >
              <path stroke-linecap="round" stroke-linejoin="round" d="M13 3L5 13h6l-1 8l8-11h-6l1-7z" />
            </svg>
            <span class="absolute -bottom-1 -right-1 h-2 w-2 bg-nexus-500 shadow-glow-orange"></span>
          </span>

          <div class="text-center space-y-1">
            <h1 class="nx-display text-xl text-zinc-50 tracking-[0.06em]">
              {$_('login.title')}
            </h1>
            <p class="font-mono text-[11px] uppercase tracking-command text-zinc-500">
              {$_('login.subtitle')}
            </p>
          </div>
        </div>

        {#if pageError}<p role="alert" class="text-sm text-red-400">{$_(pageError)}</p>{/if}
        {#if !ProviderLogin}
          {#if !pageError}<p role="alert" class="text-sm text-zinc-400">{$_('management.loginComponentUnavailable')}</p>{/if}
        {:else if instance}
          {#key instance.context}<ProviderLogin context={instance.context} />{/key}
        {:else if !pageError}<p role="status" class="text-sm text-zinc-400">{$_('common.loading')}</p>{/if}
        <button type="button" class="nx-btn-ghost" disabled={refreshing} onclick={refresh}>{$_('common.refresh')}</button>
      </div>

      <svelte:fragment slot="foot">
        <div class="flex items-center justify-between">
          <span class="font-mono text-[10px] uppercase tracking-chiseled text-zinc-600">
            BUNGEE REVERSE PROXY
          </span>
          <span class="font-mono text-[10px] uppercase tracking-chiseled text-zinc-600">
            v4.x
          </span>
        </div>
      </svelte:fragment>
    </PanelCard>
  </div>
</div>
