<script lang="ts">
  import type { FailoverConfig, ResponseRetryRule } from '$api/routes';
  import { _ } from '$i18n';
  import { BCheckbox } from '$components/industrial';
  import { Input } from '$components/ui/input';
  import { IconButton } from '$components/industrial';

  export let failover: FailoverConfig | undefined = undefined;
  export let label: string = 'Failover';
  export let showHelp: boolean = true;

  let initialized = false;
  let enabled = false;

  let retryOnInput = '';

  let retryOnResponseRules: { status?: number; body_contains: string }[] = [];

  let consecutiveFailures: number | undefined;
  let healthySuccesses: number | undefined;
  let autoDisableThreshold: number | undefined;

  let backoffBaseMs: number | undefined;
  let probeTimeoutMs: number | undefined;

  let slowStartEnabled = false;
  let slowStartDurationMs: number | undefined;
  let slowStartInitialWeightFactor: number | undefined;

  function parseStatusCodes(input: string): (number | string)[] {
    return input
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => {
        const n = parseInt(s);
        if (!isNaN(n) && n.toString() === s) {
          return n;
        }
        return s;
      });
  }

  function compactObject<T extends Record<string, any>>(value: T): T | undefined {
    const entries = Object.entries(value).filter(([, child]) => {
      if (child === undefined) return false;
      if (typeof child === 'object' && child !== null && !Array.isArray(child) && Object.keys(child).length === 0) {
        return false;
      }
      return true;
    });

    return entries.length > 0 ? Object.fromEntries(entries) as T : undefined;
  }

  function initializeFromProps(): void {
    enabled = failover?.enabled ?? false;
    const retryOn = Array.isArray(failover?.retry_on)
      ? failover.retry_on
      : failover?.retry_on !== undefined
        ? [failover.retry_on]
        : [500, 502, 503, 504];
    retryOnInput = retryOn.join(', ');

    retryOnResponseRules = (failover?.retry_on_response ?? []).map(r => ({
      status: r.status,
      body_contains: r.body_contains,
    }));

    consecutiveFailures = failover?.passive_health?.consecutive_failures;
    healthySuccesses = failover?.passive_health?.healthy_successes;
    autoDisableThreshold = failover?.passive_health?.auto_disable_threshold;

    backoffBaseMs = failover?.recovery?.backoff_base_ms;
    probeTimeoutMs = failover?.recovery?.probe_timeout_ms;

    slowStartEnabled = failover?.slow_start?.enabled ?? false;
    slowStartDurationMs = failover?.slow_start?.duration_ms;
    slowStartInitialWeightFactor = failover?.slow_start?.initial_weight_factor;
  }

  function syncModel(): void {
    if (!enabled) {
      failover = undefined;
      return;
    }

    const retryOn = parseStatusCodes(retryOnInput);

    const cleanedResponseRules = retryOnResponseRules
      .filter(r => r.body_contains.trim().length > 0)
      .map(r => {
        const rule: { status?: number; body_contains: string } = { body_contains: r.body_contains };
        if (r.status !== undefined && !isNaN(r.status)) {
          rule.status = r.status;
        }
        return rule;
      });

    failover = compactObject({
      enabled: true,
      retry_on: retryOn.length > 0 ? retryOn : [500, 502, 503, 504],
      retry_on_response: cleanedResponseRules.length > 0 ? cleanedResponseRules : undefined,
      passive_health: compactObject({
        consecutive_failures: consecutiveFailures,
        healthy_successes: healthySuccesses,
        auto_disable_threshold: autoDisableThreshold,
      }),
      recovery: compactObject({
        backoff_base_ms: backoffBaseMs,
        probe_timeout_ms: probeTimeoutMs,
      }),
      slow_start: slowStartEnabled
        ? compactObject({
            enabled: true,
            duration_ms: slowStartDurationMs,
            initial_weight_factor: slowStartInitialWeightFactor,
          })
        : undefined,
    });
  }

  function addResponseRule(): void {
    retryOnResponseRules = [...retryOnResponseRules, { status: undefined, body_contains: '' }];
    syncModel();
  }

  function removeResponseRule(idx: number): void {
    retryOnResponseRules = retryOnResponseRules.filter((_, i) => i !== idx);
    syncModel();
  }

  function updateResponseRuleStatus(idx: number, value: string): void {
    const v = value.trim();
    retryOnResponseRules = retryOnResponseRules.map((r, i) =>
      i === idx ? { ...r, status: v.length > 0 && !isNaN(Number(v)) ? Number(v) : undefined } : r
    );
    syncModel();
  }

  function updateResponseRuleBodyContains(idx: number, value: string): void {
    retryOnResponseRules = retryOnResponseRules.map((r, i) =>
      i === idx ? { ...r, body_contains: value } : r
    );
    syncModel();
  }

  $: if (!initialized) {
    initializeFromProps();
    initialized = true;
    syncModel();
  }
</script>

<div class="w-full space-y-1">
  <div class="block">
    <span class="nx-label-sm font-semibold">{label}</span>
    {#if showHelp}
      <span class="font-mono text-[11px] uppercase tracking-command text-zinc-500">{$_('routeEditor.failoverHelp')}</span>
    {/if}
  </div>

  <div class="space-y-4">
    <div class="space-y-1">
      <BCheckbox
        checked={enabled}
        onchange={(v) => { enabled = v; syncModel(); }}
        label={$_('routeEditor.enableFailover')}
      />
    </div>

    {#if enabled}
      <div class="space-y-1.5">
        <label class="block" for="failover-status-codes">
          <span class="nx-label-sm">{$_('routeEditor.retryableStatusCodes')}</span>
        </label>
        <Input id="failover-status-codes" type="text" placeholder={$_('routeEditor.retryableStatusCodesPlaceholder')} value={retryOnInput} oninput={(e) => { retryOnInput = (e.target as HTMLInputElement).value; syncModel(); }} />
        <div class="block">
          <span class="font-mono text-[11px] uppercase tracking-command text-zinc-500">{$_('routeEditor.retryableStatusCodesHelp')}</span>
        </div>
      </div>

      <div class="border border-carbon-600 bg-carbon-950/60">
        <div class="px-3 py-2 font-mono text-[11px] uppercase tracking-command text-zinc-200 border-b border-carbon-600">{$_('routeEditor.retryOnResponseTitle')}</div>
        <div class="p-3 space-y-3">
          <div class="text-xs text-zinc-500 bg-carbon-700 rounded p-2">{$_('routeEditor.retryOnResponseHelp')}</div>

          {#if retryOnResponseRules.length > 0}
            <div class="space-y-2">
              {#each retryOnResponseRules as rule, idx}
                <div class="grid grid-cols-[5rem_1fr_auto] gap-2 items-center">
                  <Input
                    type="number"
                    placeholder="ANY"
                    value={rule.status ?? ''}
                    oninput={(e) => updateResponseRuleStatus(idx, (e.target as HTMLInputElement).value)}
                    min="100"
                    max="599"
                  />
                  <Input
                    type="text"
                    placeholder={$_('routeEditor.retryOnResponseBodyPlaceholder')}
                    value={rule.body_contains}
                    oninput={(e) => updateResponseRuleBodyContains(idx, (e.target as HTMLInputElement).value)}
                  />
                  <IconButton
                    label={$_('routeEditor.retryOnResponseRemove')}
                    onclick={() => removeResponseRule(idx)}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4">
                      <path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" stroke-width="1.5" fill="none" />
                    </svg>
                  </IconButton>
                </div>
              {/each}
            </div>
          {/if}

          <button
            type="button"
            class="text-xs text-nexus-300 hover:text-nexus-200 uppercase tracking-command font-mono"
            onclick={addResponseRule}
          >
            + {$_('routeEditor.retryOnResponseAdd')}
          </button>
        </div>
      </div>

      <div class="border border-carbon-600 bg-carbon-950/60">
        <div class="px-3 py-2 font-mono text-[11px] uppercase tracking-command text-zinc-200 border-b border-carbon-600">{$_('routeEditor.passiveHealthCheck')}</div>
        <div class="p-3 space-y-4">
          <div class="text-xs text-zinc-500 bg-carbon-700 rounded p-2">{$_('routeEditor.passiveHealthCheckTooltip')}</div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div class="space-y-1.5">
              <label class="block" for="consecutive-failures-threshold"><span class="nx-label-sm">{$_('routeEditor.consecutiveFailuresThreshold')}</span></label>
              <Input id="consecutive-failures-threshold" type="number" placeholder="3" value={consecutiveFailures ?? ''} oninput={(e) => { consecutiveFailures = (e.target as HTMLInputElement).value ? Number((e.target as HTMLInputElement).value) : undefined; syncModel(); }} min="1" />
              <div class="block"><span class="font-mono text-[11px] uppercase tracking-command text-zinc-500">{$_('routeEditor.consecutiveFailuresThresholdHelp')}</span></div>
            </div>

            <div class="space-y-1.5">
              <label class="block" for="recovery-interval-ms"><span class="nx-label-sm">{$_('routeEditor.recoveryIntervalMs')}</span></label>
              <Input id="recovery-interval-ms" type="number" placeholder="5000" value={backoffBaseMs ?? ''} oninput={(e) => { backoffBaseMs = (e.target as HTMLInputElement).value ? Number((e.target as HTMLInputElement).value) : undefined; syncModel(); }} min="1000" />
              <div class="block"><span class="font-mono text-[11px] uppercase tracking-command text-zinc-500">{$_('routeEditor.recoveryIntervalHelp')}</span></div>
            </div>

            <div class="space-y-1.5">
              <label class="block" for="healthy-threshold"><span class="nx-label-sm">{$_('routeEditor.healthyThreshold')}</span></label>
              <Input id="healthy-threshold" type="number" placeholder="2" value={healthySuccesses ?? ''} oninput={(e) => { healthySuccesses = (e.target as HTMLInputElement).value ? Number((e.target as HTMLInputElement).value) : undefined; syncModel(); }} min="1" />
              <div class="block"><span class="font-mono text-[11px] uppercase tracking-command text-zinc-500">{$_('routeEditor.healthyThresholdHelp')}</span></div>
            </div>

            <div class="space-y-1.5">
              <label class="block" for="recovery-timeout-ms"><span class="nx-label-sm">{$_('routeEditor.recoveryTimeoutMs')}</span></label>
              <Input id="recovery-timeout-ms" type="number" placeholder="3000" value={probeTimeoutMs ?? ''} oninput={(e) => { probeTimeoutMs = (e.target as HTMLInputElement).value ? Number((e.target as HTMLInputElement).value) : undefined; syncModel(); }} min="100" />
              <div class="block"><span class="font-mono text-[11px] uppercase tracking-command text-zinc-500">{$_('routeEditor.recoveryTimeoutHelp')}</span></div>
            </div>

            <div class="space-y-1.5">
              <label class="block" for="auto-disable-threshold"><span class="nx-label-sm">{$_('routeEditor.autoDisableThreshold')}</span></label>
              <Input id="auto-disable-threshold" type="number" placeholder={$_('routeEditor.autoDisableThresholdPlaceholder')} value={autoDisableThreshold ?? ''} oninput={(e) => { autoDisableThreshold = (e.target as HTMLInputElement).value ? Number((e.target as HTMLInputElement).value) : undefined; syncModel(); }} min="1" />
              <div class="block"><span class="font-mono text-[11px] uppercase tracking-command text-zinc-500">{$_('routeEditor.autoDisableThresholdHelp')}</span></div>
            </div>
          </div>
        </div>
      </div>

      <div class="border border-carbon-600 bg-carbon-950/60">
        <div class="px-3 py-2 font-mono text-[11px] uppercase tracking-command text-zinc-200 border-b border-carbon-600">{$_('routeEditor.slowStart')}</div>
        <div class="p-3 space-y-4">
          <div class="text-xs text-zinc-500 bg-carbon-700 rounded p-2">{$_('routeEditor.slowStartTooltip')}</div>
          <div class="space-y-1.5">
            <BCheckbox
              checked={slowStartEnabled}
              onchange={(v) => { slowStartEnabled = v; syncModel(); }}
              label={$_('routeEditor.enableSlowStart')}
            />
          </div>

          {#if slowStartEnabled}
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div class="space-y-1.5">
                <label class="block" for="slow-start-duration-ms"><span class="nx-label-sm">{$_('routeEditor.slowStartDurationMs')}</span></label>
                <Input id="slow-start-duration-ms" type="number" placeholder="30000" value={slowStartDurationMs ?? ''} oninput={(e) => { slowStartDurationMs = (e.target as HTMLInputElement).value ? Number((e.target as HTMLInputElement).value) : undefined; syncModel(); }} min="1000" />
                <div class="block"><span class="font-mono text-[11px] uppercase tracking-command text-zinc-500">{$_('routeEditor.slowStartDurationMsHelp')}</span></div>
              </div>

              <div class="space-y-1.5">
                <label class="block" for="slow-start-initial-weight-factor"><span class="nx-label-sm">{$_('routeEditor.slowStartInitialWeightFactor')}</span></label>
                <Input id="slow-start-initial-weight-factor" type="number" placeholder="0.1" value={slowStartInitialWeightFactor ?? ''} oninput={(e) => { slowStartInitialWeightFactor = (e.target as HTMLInputElement).value ? Number((e.target as HTMLInputElement).value) : undefined; syncModel(); }} min="0.01" max="1" step="0.01" />
                <div class="block"><span class="font-mono text-[11px] uppercase tracking-command text-zinc-500">{$_('routeEditor.slowStartInitialWeightFactorHelp')}</span></div>
              </div>
            </div>
          {/if}
        </div>
      </div>
    {/if}
  </div>
</div>
