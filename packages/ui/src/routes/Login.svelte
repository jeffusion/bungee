<script lang="ts">
  import { _ } from '$i18n';
  import { login } from '$stores/auth';
  import { loginWithToken } from '$api/auth';
  import { toast } from '$stores/toast';
  import { LoadingIndicator, PanelCard } from '$components/industrial';

  let tokenInput = '';
  let loading = false;
  let error = '';

  async function handleLogin() {
    if (!tokenInput.trim()) {
      error = $_('login.required');
      return;
    }

    loading = true;
    error = '';

    try {
      const result = await loginWithToken(tokenInput);
      if (result.success) {
        login(tokenInput);
        toast.show($_('login.success'), 'success');
        window.location.hash = '#/';
      } else {
        error = result.error || $_('login.unauthorized');
      }
    } catch (err) {
      error = $_('login.failed', { values: { error: (err as Error).message } });
    } finally {
      loading = false;
    }
  }

  function handleKeyPress(event: KeyboardEvent) {
    if (event.key === 'Enter' && !loading) handleLogin();
  }
</script>

<div class="min-h-screen flex items-center justify-center p-4 bg-carbon-950 nx-grid-bg relative overflow-hidden">
  <!-- Orange glow accents -->
  <div class="absolute -top-32 -left-32 h-96 w-96 rounded-full bg-nexus-500/10 blur-3xl pointer-events-none"></div>
  <div class="absolute -bottom-32 -right-32 h-96 w-96 rounded-full bg-nexus-500/5 blur-3xl pointer-events-none"></div>

  <!-- Top accent line -->
  <div class="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-nexus-500 to-transparent"></div>

  <div class="relative w-full max-w-md">
    <PanelCard title="AUTHENTICATION REQUIRED" tag="BUNGEE">
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

        <!-- Token input -->
        <div class="space-y-2">
          <label for="token-input" class="block font-mono text-[10px] uppercase tracking-chiseled text-zinc-500">
            // {$_('login.token')}
          </label>
          <input
            id="token-input"
            type="password"
            placeholder={$_('login.tokenPlaceholder')}
            class="nx-input"
            class:border-red-500={!!error}
            bind:value={tokenInput}
            on:keypress={handleKeyPress}
            disabled={loading}
            autocomplete="off"
          />

          {#if error}
            <div class="flex items-center gap-2 pt-1">
              <span class="nx-dot-danger"></span>
              <span class="font-mono text-[10px] uppercase tracking-command text-red-300">{error}</span>
            </div>
          {/if}
        </div>

        <!-- Submit -->
        <button
          class="nx-btn-primary w-full justify-center"
          on:click={handleLogin}
          disabled={loading}
        >
          {#if loading}
            <LoadingIndicator label="" size="xs" centered={false} />
            <span>{$_('login.loggingIn')}</span>
          {:else}
            <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2.4">
              <path stroke-linecap="round" stroke-linejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
            </svg>
            <span>{$_('login.submit')}</span>
          {/if}
        </button>
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
