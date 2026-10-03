<script lang="ts">
  import { _ } from '$i18n';
  import { accountError } from '$components/domain/plugin/activation-state';
  import { authMode } from '$stores/auth';
  import { getNativeWidget } from '$components/native-widgets';
  import { readAuthMode, verifyToken } from '$api/auth';
  import { PanelCard } from '$components/industrial';

  interface Props {
    onAuthenticated?: () => Promise<boolean>;
  }

  let { onAuthenticated }: Props = $props();
  let error = $state(''), modeError = $state(''), errorDetail = $state('');
  const ProviderLogin = $derived($authMode?.provider?.loginComponent ? getNativeWidget($authMode.provider.loginComponent) : null);
  async function initializeMode() { try { await readAuthMode(); modeError = ''; } catch(e) { const failure = accountError(e); modeError = failure.key; errorDetail = failure.detail; } }
  $effect(() => { void initializeMode(); });
  async function providerLoggedIn() { try { const result = await verifyToken(); if (!result.success) throw new Error('unauthorized'); await onAuthenticated?.(); } catch(e) { const failure = accountError(e); error = failure.key; errorDetail = failure.detail; } }
</script>

<div data-testid="page-login" class="min-h-screen flex items-center justify-center p-4 bg-carbon-950 nx-grid-bg relative overflow-hidden">
  <div class="relative w-full max-w-md">
    <PanelCard title={$_('pluginActivation.loginTitle')} tag="BUNGEE">
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

        {#if modeError || !$authMode}<p role="alert" class="text-sm text-zinc-400">{modeError ? $_(modeError) : $_('common.loading')}</p><button class="nx-btn-ghost" onclick={initializeMode}>{$_('common.refresh')}</button>
        {:else if $authMode.mode === 'plugin'}
          {#if ProviderLogin}<ProviderLogin on:login={providerLoggedIn} />{:else}<p role="alert">{$_('management.providerUnavailable')}</p>{/if}
        {/if}
        {#if error}<p role="alert" class="text-sm text-red-400">{$_(error)}</p>{/if}
        {#if errorDetail}<details class="text-sm text-zinc-400"><summary>{$_('pluginActivation.technicalDetails')}</summary><pre class="whitespace-pre-wrap break-all">{errorDetail}</pre></details>{/if}
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
