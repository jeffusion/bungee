<script lang="ts">
import type { Route, StickySessionConfig } from '$api/routes';
import type { ValidationError } from '$validation/route-validator';
import { _ } from '$i18n';
import { IndustrialToggle } from '$components/industrial';

  export let route: Route;
  export let errors: ValidationError[] = [];

  let stickySessionEnabled = false;
  let stickySessionExpression = '';
  let stickyExpressionError: ValidationError | undefined;

  $: stickySessionEnabled = route.sticky_session?.enabled === true;
  $: stickySessionExpression = route.sticky_session?.key_expression ?? '';
  $: stickyExpressionError = errors.find((error) => error.field === 'sticky_session.key_expression');

  function setStickyEnabled(enabled: boolean): void {
    const current = route.sticky_session;
    const next: StickySessionConfig = { enabled };
    if (current?.key_expression) next.key_expression = current.key_expression;
    route = { ...route, sticky_session: next };
  }

  function setStickyKeyExpression(value: string): void {
    const current = route.sticky_session;
    const next: StickySessionConfig = { enabled: current?.enabled ?? true };
    if (value.trim().length > 0) next.key_expression = value;
    route = { ...route, sticky_session: next };
  }

  function handleStickyEnabledChange(event: Event): void {
    if (event.currentTarget instanceof HTMLInputElement) setStickyEnabled(event.currentTarget.checked);
  }

  function handleStickyExpressionChange(event: Event): void {
    if (event.currentTarget instanceof HTMLInputElement) setStickyKeyExpression(event.currentTarget.value);
  }
</script>

<div class="space-y-4">
  <p class="text-xs text-zinc-500">{$_('routeEditor.stickySessionHelp')}</p>

  <label class="flex items-center gap-3 cursor-pointer">
    <IndustrialToggle checked={stickySessionEnabled} title={$_('routeEditor.enableStickySession')} on:change={(event) => setStickyEnabled(event.detail)} />
    <span class="font-mono text-[11px] uppercase tracking-command text-zinc-300">
      {$_('routeEditor.enableStickySession')}
    </span>
  </label>

  {#if stickySessionEnabled}
    <div class="border-l-2 border-l-nexus-500/40 pl-4">
      <label class="block space-y-1.5">
        <span class="nx-label">// {$_('routeEditor.stickySessionKeyExpression')}</span>
        <input
          type="text"
          class="nx-input"
          class:border-red-500={Boolean(stickyExpressionError)}
          value={stickySessionExpression}
          placeholder={$_('routeEditor.stickySessionKeyExpressionPlaceholder')}
          on:input={handleStickyExpressionChange}
        />
        <span
          class="font-mono text-[10px] uppercase tracking-command"
          class:text-red-300={Boolean(stickyExpressionError)}
          class:text-zinc-500={!stickyExpressionError}
        >
          {stickyExpressionError ? stickyExpressionError.message : $_('routeEditor.stickySessionKeyExpressionHelp')}
        </span>
      </label>
    </div>
  {/if}
</div>
