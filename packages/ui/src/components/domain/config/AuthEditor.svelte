<script lang="ts">
  import type { AuthConfig } from '$types';
  import { _ } from '$i18n';
  import { Input } from '$components/ui/input';
  import { BSwitch, StatusBadge, SystemAlertBar } from '$components/industrial';

  export let value: AuthConfig | undefined = undefined;
  export let label: string = 'Authentication';
  export let showHelp: boolean = true;

  let enabled = false;
  let tokens: string[] = [];
  let lastValue: AuthConfig | undefined = undefined;

  function syncLocalState(nextValue: AuthConfig | undefined) {
    enabled = nextValue?.enabled ?? false;
    tokens = nextValue?.tokens ? [...nextValue.tokens] : [];
    lastValue = nextValue;
  }

  function writeValue() {
    const nextValue: AuthConfig = {
      enabled,
      tokens: enabled ? tokens.filter(t => t.trim() !== '') : tokens,
    };
    value = nextValue;
    lastValue = value;
  }

  $: if (value !== lastValue) {
    syncLocalState(value);
  }

  function addToken() {
    tokens = [...tokens, ''];
    writeValue();
  }

  function removeToken(index: number) {
    tokens = tokens.filter((_, i) => i !== index);
    writeValue();
  }

function handleEnabledChange(checked: boolean) {
		enabled = checked;
		if (enabled && tokens.length === 0) {
			tokens = [''];
		}
		if (!enabled) {
			tokens = [];
		}
		writeValue();
	}
</script>

<div class="w-full space-y-4">
  <div class="flex flex-col gap-2 border border-carbon-600 bg-carbon-950/40 px-3 py-3 md:flex-row md:items-center md:justify-between">
    <div class="min-w-0 space-y-1">
      <div class="flex items-center gap-2">
        <span class="font-mono text-[12px] font-bold uppercase tracking-command text-zinc-100">{label}</span>
        <StatusBadge variant={enabled ? 'online' : 'muted'} dot>{enabled ? 'ACTIVE' : 'OPEN CHANNEL'}</StatusBadge>
      </div>
    {#if showHelp}
        <p class="font-mono text-[10px] uppercase tracking-command text-zinc-500">
        {$_('auth.helpText')}
        </p>
    {/if}
    </div>

	<BSwitch
		bind:checked={enabled}
		label={$_('auth.enableAuth')}
		onchange={handleEnabledChange}
	/>
  </div>

  <div class="space-y-4">
    {#if enabled}
      <!-- Tokens List -->
      <div class="border border-carbon-600 bg-carbon-950/60">
        <div class="px-3 py-2 font-mono text-[11px] uppercase tracking-command text-zinc-200 border-b border-carbon-600">
          {$_('auth.tokens')} ({tokens.length})
        </div>
        <div class="p-3 space-y-2">
          <div class="border border-carbon-600 bg-carbon-900/70 p-3 flex gap-2 font-mono text-[10px] uppercase tracking-command text-zinc-500">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="stroke-current shrink-0 w-4 h-4 text-nexus-400">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
            </svg>
            <div>
              <div>{$_('auth.expressionSupport')}</div>
              <div class="mt-1">
                <code class="border border-carbon-500 bg-carbon-800 px-1 text-[10px] text-nexus-300">{'{{ env.API_TOKEN }}'}</code>
              </div>
            </div>
          </div>

          {#each tokens as token, index}
            <div class="flex gap-2">
              <div class="flex-1">
                <Input
                  type="text"
                  placeholder={$_('auth.tokenPlaceholder')}
                  bind:value={tokens[index]}
                  class="font-mono text-xs"
                  oninput={writeValue}
                />
              </div>
              <button
                type="button"
                class="inline-flex items-center justify-center h-9 w-9 border-2 border-red-500 bg-red-500/10 text-red-300 hover:bg-red-500/20 transition-colors"
                on:click={() => removeToken(index)}
                title="Remove token"
              >
                <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2.4">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          {/each}

          <button
            type="button"
            class="nx-btn-ghost nx-btn-sm"
            on:click={addToken}
          >
            + {$_('auth.addToken')}
          </button>
        </div>
      </div>

      <!-- Security Notice -->
      <SystemAlertBar tone="warn" title={$_('auth.securityNotice')} />
    {/if}
  </div>
</div>
