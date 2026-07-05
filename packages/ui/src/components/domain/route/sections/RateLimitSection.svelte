<script lang="ts">
import type { Route } from '$api/routes';
import { _ } from '$i18n';
import { Input } from '$components/ui/input';
import { BSwitch } from '$components/industrial';

  export let route: Route;

  $: if (!route.rate_limit) {
    route.rate_limit = { enabled: false };
  }
</script>

<div class="space-y-4">
  <p class="text-xs text-zinc-500">{$_('routeEditor.rateLimitHelp')}</p>

  <BSwitch bind:checked={route.rate_limit.enabled} label={$_('routeEditor.enableRateLimit')} />

  {#if route.rate_limit.enabled}
    <div class="space-y-3">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label class="block space-y-1.5">
          <span class="font-mono text-[11px] uppercase tracking-command text-zinc-400">// {$_('routeEditor.requestsPerSecond')}</span>
          <Input
            type="number"
            bind:value={route.rate_limit.requests_per_second}
            placeholder="e.g. 10"
          />
        </label>

        <label class="block space-y-1.5">
          <span class="font-mono text-[11px] uppercase tracking-command text-zinc-400">// {$_('routeEditor.burst')}</span>
          <Input
            type="number"
            bind:value={route.rate_limit.burst}
            placeholder="e.g. 20"
          />
        </label>
      </div>

      <label class="block space-y-1.5">
        <span class="font-mono text-[11px] uppercase tracking-command text-zinc-400">// {$_('routeEditor.rateLimitKeyExpression')}</span>
        <Input
          type="text"
          bind:value={route.rate_limit.key_expression}
          placeholder={'e.g. {{ headers.authorization }}'}
        />
        <span class="font-mono text-[10px] uppercase tracking-command text-zinc-500">
          {$_('routeEditor.rateLimitKeyExpressionHelp')}
        </span>
      </label>
    </div>
  {/if}
</div>
