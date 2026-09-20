<script lang="ts">
  import type { AuthConfig } from '$types';
  import { _ } from '$i18n';
  import { Input } from '$components/ui/input';
  import { Button } from '$components/ui/button';
  import { IndustrialToggle } from '$components/industrial';
  import { toggleAuth } from './auth-value';

  let { value = $bindable<AuthConfig | undefined>(), label = '', showHelp = true, disabled = false }:
    { value?: AuthConfig; label?: string; showHelp?: boolean; disabled?: boolean } = $props();
  let tokens = $state<string[]>([]);
  let lastValue = $state<AuthConfig | undefined>();
  let revealed = $state(false);
  const id = $props.id();
  $effect(() => {
    if (value !== lastValue) {
      tokens = [...(value?.tokens ?? [])];
      if (value?.enabled && !tokens.length) tokens = [''];
      lastValue = value;
    }
  });
  function writeTokens(next: string[]) {
    tokens = next;
    value = { ...value, enabled: value?.enabled ?? false, tokens: [...next] };
    lastValue = value;
  }
</script>

<div class="space-y-4">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <div class="space-y-1">
      <label for={`${id}-enabled`} class="nx-field-label">{label || $_('auth.enableAuth')}</label>
      {#if showHelp}<p class="text-sm text-zinc-400">{$_('auth.helpText')}</p>{/if}
    </div>
    <IndustrialToggle id={`${id}-enabled`} checked={value?.enabled ?? false} {disabled}
      onchange={(enabled) => { value = toggleAuth(value, enabled); }} label={label || $_('auth.enableAuth')} />
  </div>
  {#if value?.enabled || tokens.length}
    <div class="space-y-3 border-t border-carbon-600 pt-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="nx-field-label">{$_('auth.tokens')} ({tokens.length})</span>
        <Button variant="ghost" size="sm" onclick={() => revealed = !revealed} aria-pressed={revealed} {disabled}>
          {$_(revealed ? 'settings.hideTokens' : 'settings.showTokens')}
        </Button>
      </div>
      {#each tokens as token, index}
        <div class="flex items-end gap-2">
          <label class="block min-w-0 flex-1 space-y-1.5">
            <span class="nx-field-label">{$_('login.token')} {index + 1}</span>
            <Input class="focus-visible:border-nexus-500" type={revealed ? 'text' : 'password'} value={token} {disabled} autocomplete="off"
              aria-label={`${$_('login.token')} ${index + 1}`} data-testid="auth-token-input"
              oninput={(e) => writeTokens(tokens.map((t, i) => i === index ? e.currentTarget.value : t))} />
          </label>
          <Button variant="outline" {disabled} aria-label={`${$_('common.delete')} ${$_('login.token')} ${index + 1}`}
            onclick={() => writeTokens(tokens.filter((_, i) => i !== index))}>{$_('common.delete')}</Button>
        </div>
      {/each}
      <Button variant="ghost" size="sm" {disabled} onclick={() => writeTokens([...tokens, ''])}>{$_('auth.addToken')}</Button>
      <p class="text-sm text-zinc-400">{$_('auth.expressionSupport')} <code>{'{{ env.API_TOKEN }}'}</code></p>
      {#if !value?.enabled}<p class="text-sm text-zinc-400">{$_('settings.tokensRetained')}</p>{/if}
    </div>
  {/if}
</div>
