<script lang="ts">
  import type { Route, StickySessionConfig } from '../../api/routes';
  import type { ValidationError } from '../../validation/route-validator';
  import { _ } from '../../i18n';

  export let route: Route;
  export let errors: ValidationError[] = [];

  let stickySessionEnabled = false;
  let stickySessionExpression = '';
  let stickyExpressionError: ValidationError | undefined;

  $: stickySessionEnabled = route.stickySession?.enabled === true;
  $: stickySessionExpression = route.stickySession?.keyExpression ?? '';
  $: stickyExpressionError = errors.find((error) => error.field === 'stickySession.keyExpression');

  function setStickyEnabled(enabled: boolean): void {
    const current = route.stickySession;
    if (enabled) {
      const next: StickySessionConfig = {
        enabled: true
      };

      if (current?.keyExpression) {
        next.keyExpression = current.keyExpression;
      }

      route = {
        ...route,
        stickySession: next
      };
      return;
    }

    const next: StickySessionConfig = {
      enabled: false
    };

    if (current?.keyExpression) {
      next.keyExpression = current.keyExpression;
    }

    route = {
      ...route,
      stickySession: next
    };
  }

  function setStickyKeyExpression(value: string): void {
    const current = route.stickySession;
    const next: StickySessionConfig = {
      enabled: current?.enabled ?? true
    };

    if (value.trim().length > 0) {
      next.keyExpression = value;
    }

    route = {
      ...route,
      stickySession: next
    };
  }

  function handleStickyEnabledChange(event: Event): void {
    if (event.currentTarget instanceof HTMLInputElement) {
      setStickyEnabled(event.currentTarget.checked);
    }
  }

  function handleStickyExpressionInput(event: Event): void {
    if (event.currentTarget instanceof HTMLInputElement) {
      setStickyKeyExpression(event.currentTarget.value);
    }
  }
</script>

<div class="space-y-4">
  <div>
    <h3 class="text-lg font-semibold">{$_('routeEditor.stickySessionTitle')}</h3>
    <p class="text-sm text-gray-500 mt-1">
      {$_('routeEditor.stickySessionHelp')}
    </p>
  </div>

  <div class="form-control">
    <label class="label cursor-pointer justify-start gap-4">
      <input
        type="checkbox"
        class="checkbox"
        checked={stickySessionEnabled}
        on:change={handleStickyEnabledChange}
      />
      <span class="label-text">{$_('routeEditor.enableStickySession')}</span>
    </label>
  </div>

  {#if stickySessionEnabled}
    <div class="form-control">
      <label class="label" for="sticky-session-key-expression">
        <span class="label-text">{$_('routeEditor.stickySessionKeyExpression')}</span>
      </label>
      <input
        id="sticky-session-key-expression"
        type="text"
        class="input input-bordered input-sm font-mono"
        class:input-error={Boolean(stickyExpressionError)}
        value={stickySessionExpression}
        placeholder={$_('routeEditor.stickySessionKeyExpressionPlaceholder')}
        on:input={handleStickyExpressionInput}
      />
      <div class="label">
        <span class="label-text-alt text-xs" class:text-error={Boolean(stickyExpressionError)}>
          {stickyExpressionError ? stickyExpressionError.message : $_('routeEditor.stickySessionKeyExpressionHelp')}
        </span>
      </div>
    </div>
  {/if}
</div>
