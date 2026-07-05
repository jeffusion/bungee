<script lang="ts">
  import type { FailoverConfig } from '$api/routes';
  import { _ } from '$i18n';
  import { BCheckbox } from '$components/industrial';
  import { Input } from '$components/ui/input';
  import { Textarea } from '$components/ui/textarea';

  export let failover: FailoverConfig | undefined = undefined;
  export let label: string = 'Failover';
  export let showHelp: boolean = true;

  let initialized = false;
  let enabled = false;

  let retryOnInput = '';

  let consecutiveFailures: number | undefined;
  let healthySuccesses: number | undefined;
  let autoDisableThreshold: number | undefined;
  let autoEnableOnActiveHealthCheck = true;

  let probeIntervalMs: number | undefined;
  let probeTimeoutMs: number | undefined;

  let healthCheckEnabled = false;
  let healthCheckIntervalMs: number | undefined;
  let healthCheckTimeoutMs: number | undefined;
  let healthCheckPath: string | undefined;
  let healthCheckMethod: string | undefined;
  let healthCheckBody: string | undefined;
  let healthCheckContentType: string | undefined;
  let healthCheckHeadersInput = '';
  let healthCheckQueryInput = '';
  let healthCheckExpectedStatusInput = '';
  let healthCheckUnhealthyThreshold: number | undefined;
  let healthCheckHealthyThreshold: number | undefined;

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

  function parseNumberStatusCodes(input: string): number[] {
    return input
      .split(',')
      .map((s) => parseInt(s.trim()))
      .filter((n) => !isNaN(n) && n >= 100 && n < 600);
  }

  function formatKeyValuePairs(obj: Record<string, string> | undefined): string {
    if (!obj) return '';
    return Object.entries(obj)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n');
  }

  function parseKeyValuePairs(input: string): Record<string, string> | undefined {
    if (!input.trim()) return undefined;

    const result: Record<string, string> = {};
    const lines = input.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const colonIndex = trimmed.indexOf(':');
      if (colonIndex === -1) continue;

      const key = trimmed.substring(0, colonIndex).trim();
      const value = trimmed.substring(colonIndex + 1).trim();

      if (key) {
        result[key] = value;
      }
    }

    return Object.keys(result).length > 0 ? result : undefined;
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

    consecutiveFailures = failover?.passive_health?.consecutive_failures;
    healthySuccesses = failover?.passive_health?.healthy_successes;
    autoDisableThreshold = failover?.passive_health?.auto_disable_threshold;
    autoEnableOnActiveHealthCheck = failover?.passive_health?.auto_enable_on_active_health_check ?? true;

    probeIntervalMs = failover?.recovery?.probe_interval_ms;
    probeTimeoutMs = failover?.recovery?.probe_timeout_ms;

    healthCheckEnabled = failover?.health_check?.enabled ?? false;
    healthCheckIntervalMs = failover?.health_check?.interval_ms;
    healthCheckTimeoutMs = failover?.health_check?.timeout_ms;
    healthCheckPath = failover?.health_check?.path;
    healthCheckMethod = failover?.health_check?.method;
    healthCheckBody = failover?.health_check?.body;
    healthCheckContentType = failover?.health_check?.content_type;
    healthCheckHeadersInput = formatKeyValuePairs(failover?.health_check?.headers);
    healthCheckQueryInput = formatKeyValuePairs(failover?.health_check?.query);
    healthCheckExpectedStatusInput = (failover?.health_check?.expected_status || [200]).join(', ');
    healthCheckUnhealthyThreshold = failover?.health_check?.unhealthy_threshold;
    healthCheckHealthyThreshold = failover?.health_check?.healthy_threshold;

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
    const expectedStatus = parseNumberStatusCodes(healthCheckExpectedStatusInput);
    const healthCheckHeaders = parseKeyValuePairs(healthCheckHeadersInput);
    const healthCheckQuery = parseKeyValuePairs(healthCheckQueryInput);

    failover = compactObject({
      enabled: true,
      retry_on: retryOn.length > 0 ? retryOn : [500, 502, 503, 504],
      passive_health: compactObject({
        consecutive_failures: consecutiveFailures,
        healthy_successes: healthySuccesses,
        auto_disable_threshold: autoDisableThreshold,
        auto_enable_on_active_health_check: autoEnableOnActiveHealthCheck,
      }),
      recovery: compactObject({
        probe_interval_ms: probeIntervalMs,
        probe_timeout_ms: probeTimeoutMs,
      }),
      slow_start: slowStartEnabled
        ? compactObject({
            enabled: true,
            duration_ms: slowStartDurationMs,
            initial_weight_factor: slowStartInitialWeightFactor,
          })
        : undefined,
      health_check: healthCheckEnabled
        ? compactObject({
            enabled: true,
            interval_ms: healthCheckIntervalMs,
            timeout_ms: healthCheckTimeoutMs,
            path: healthCheckPath,
            method: healthCheckMethod,
            body: healthCheckBody,
            content_type: healthCheckContentType,
            headers: healthCheckHeaders,
            query: healthCheckQuery,
            expected_status: expectedStatus.length > 0 ? expectedStatus : [200],
            unhealthy_threshold: healthCheckUnhealthyThreshold,
            healthy_threshold: healthCheckHealthyThreshold,
          })
        : undefined,
    });
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
              <Input id="recovery-interval-ms" type="number" placeholder="5000" value={probeIntervalMs ?? ''} oninput={(e) => { probeIntervalMs = (e.target as HTMLInputElement).value ? Number((e.target as HTMLInputElement).value) : undefined; syncModel(); }} min="1000" />
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

            <div class="space-y-1.5">
              <BCheckbox
                checked={autoEnableOnActiveHealthCheck}
                onchange={(v) => { autoEnableOnActiveHealthCheck = v; syncModel(); }}
                label={$_('routeEditor.autoEnableOnHealthCheck')}
              />
              <div class="block"><span class="font-mono text-[11px] uppercase tracking-command text-zinc-500">{$_('routeEditor.autoEnableOnHealthCheckHelp')}</span></div>
            </div>
          </div>
        </div>
      </div>

      <div class="border border-carbon-600 bg-carbon-950/60">
        <div class="px-3 py-2 font-mono text-[11px] uppercase tracking-command text-zinc-200 border-b border-carbon-600">{$_('routeEditor.activeHealthCheck')}</div>
        <div class="p-3 space-y-4">
          <div class="text-xs text-zinc-500 bg-carbon-700 rounded p-2">{$_('routeEditor.activeHealthCheckTooltip')}</div>
          <div class="space-y-1.5">
            <BCheckbox
              checked={healthCheckEnabled}
              onchange={(v) => { healthCheckEnabled = v; syncModel(); }}
              label={$_('routeEditor.enableActiveHealthCheck')}
            />
          </div>

          {#if healthCheckEnabled}
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div class="space-y-1.5">
                <label class="block" for="health-check-interval-ms"><span class="nx-label-sm">{$_('routeEditor.healthCheckIntervalMs')}</span></label>
                <Input id="health-check-interval-ms" type="number" placeholder="10000" value={healthCheckIntervalMs ?? ''} oninput={(e) => { healthCheckIntervalMs = (e.target as HTMLInputElement).value ? Number((e.target as HTMLInputElement).value) : undefined; syncModel(); }} min="1000" />
                <div class="block"><span class="font-mono text-[11px] uppercase tracking-command text-zinc-500">{$_('routeEditor.healthCheckIntervalMsHelp')}</span></div>
              </div>

              <div class="space-y-1.5">
                <label class="block" for="health-check-timeout-ms"><span class="nx-label-sm">{$_('routeEditor.healthCheckTimeoutMs')}</span></label>
                <Input id="health-check-timeout-ms" type="number" placeholder="3000" value={healthCheckTimeoutMs ?? ''} oninput={(e) => { healthCheckTimeoutMs = (e.target as HTMLInputElement).value ? Number((e.target as HTMLInputElement).value) : undefined; syncModel(); }} min="100" />
                <div class="block"><span class="font-mono text-[11px] uppercase tracking-command text-zinc-500">{$_('routeEditor.healthCheckTimeoutMsHelp')}</span></div>
              </div>

              <div class="space-y-1.5">
                <label class="block" for="health-check-path"><span class="nx-label-sm">{$_('routeEditor.healthCheckPath')}</span></label>
                <Input id="health-check-path" type="text" placeholder="/health" value={healthCheckPath ?? ''} oninput={(e) => { healthCheckPath = (e.target as HTMLInputElement).value; syncModel(); }} />
                <div class="block"><span class="font-mono text-[11px] uppercase tracking-command text-zinc-500">{$_('routeEditor.healthCheckPathHelp')}</span></div>
              </div>

              <div class="space-y-1.5">
                <label class="block" for="health-check-method"><span class="nx-label-sm">{$_('routeEditor.healthCheckMethod')}</span></label>
                <Input id="health-check-method" type="text" placeholder="GET" value={healthCheckMethod ?? ''} oninput={(e) => { healthCheckMethod = (e.target as HTMLInputElement).value; syncModel(); }} />
              </div>

              <div class="space-y-1.5">
                <label class="block" for="health-check-expected-status"><span class="nx-label-sm">{$_('routeEditor.healthCheckExpectedStatus')}</span></label>
                <Input id="health-check-expected-status" type="text" placeholder="200" value={healthCheckExpectedStatusInput} oninput={(e) => { healthCheckExpectedStatusInput = (e.target as HTMLInputElement).value; syncModel(); }} />
                <div class="block"><span class="font-mono text-[11px] uppercase tracking-command text-zinc-500">{$_('routeEditor.healthCheckExpectedStatusHelp')}</span></div>
              </div>

              <div class="space-y-1.5">
                <label class="block" for="health-check-unhealthy-threshold"><span class="nx-label-sm">{$_('routeEditor.healthCheckUnhealthyThreshold')}</span></label>
                <Input id="health-check-unhealthy-threshold" type="number" placeholder="3" value={healthCheckUnhealthyThreshold ?? ''} oninput={(e) => { healthCheckUnhealthyThreshold = (e.target as HTMLInputElement).value ? Number((e.target as HTMLInputElement).value) : undefined; syncModel(); }} min="1" />
                <div class="block"><span class="font-mono text-[11px] uppercase tracking-command text-zinc-500">{$_('routeEditor.healthCheckUnhealthyThresholdHelp')}</span></div>
              </div>

              <div class="space-y-1.5">
                <label class="block" for="health-check-healthy-threshold"><span class="nx-label-sm">{$_('routeEditor.healthCheckHealthyThreshold')}</span></label>
                <Input id="health-check-healthy-threshold" type="number" placeholder="2" value={healthCheckHealthyThreshold ?? ''} oninput={(e) => { healthCheckHealthyThreshold = (e.target as HTMLInputElement).value ? Number((e.target as HTMLInputElement).value) : undefined; syncModel(); }} min="1" />
                <div class="block"><span class="font-mono text-[11px] uppercase tracking-command text-zinc-500">{$_('routeEditor.healthCheckHealthyThresholdHelp')}</span></div>
              </div>

              <div class="space-y-1.5">
                <label class="block" for="health-check-content-type"><span class="nx-label-sm">{$_('routeEditor.healthCheckContentType')}</span></label>
                <Input id="health-check-content-type" type="text" placeholder="application/json" value={healthCheckContentType ?? ''} oninput={(e) => { healthCheckContentType = (e.target as HTMLInputElement).value; syncModel(); }} />
                <div class="block"><span class="font-mono text-[11px] uppercase tracking-command text-zinc-500">{$_('routeEditor.healthCheckContentTypeHelp')}</span></div>
              </div>
            </div>

            <div class="space-y-1.5">
              <label class="block" for="health-check-body"><span class="nx-label-sm">{$_('routeEditor.healthCheckBody')}</span></label>
              <Textarea id="health-check-body" rows="4" class="resize-y" value={healthCheckBody ?? ''} oninput={(e) => { healthCheckBody = (e.target as HTMLTextAreaElement).value; syncModel(); }} placeholder={$_('routeEditor.healthCheckBodyPlaceholder')} />
              <div class="block"><span class="font-mono text-[11px] uppercase tracking-command text-zinc-500">{$_('routeEditor.healthCheckBodyHelp')}</span></div>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div class="space-y-1.5">
                <label class="block" for="health-check-headers"><span class="nx-label-sm">{$_('routeEditor.healthCheckHeaders')}</span></label>
                <Textarea id="health-check-headers" rows="4" class="resize-y font-mono" value={healthCheckHeadersInput} oninput={(e) => { healthCheckHeadersInput = (e.target as HTMLTextAreaElement).value; syncModel(); }} placeholder={$_('routeEditor.healthCheckHeadersPlaceholder')} />
                <div class="block"><span class="font-mono text-[11px] uppercase tracking-command text-zinc-500">{$_('routeEditor.healthCheckHeadersHelp')}</span></div>
              </div>

              <div class="space-y-1.5">
                <label class="block" for="health-check-query"><span class="nx-label-sm">{$_('routeEditor.healthCheckQuery')}</span></label>
                <Textarea id="health-check-query" rows="4" class="resize-y font-mono" value={healthCheckQueryInput} oninput={(e) => { healthCheckQueryInput = (e.target as HTMLTextAreaElement).value; syncModel(); }} placeholder={$_('routeEditor.healthCheckQueryPlaceholder')} />
                <div class="block"><span class="font-mono text-[11px] uppercase tracking-command text-zinc-500">{$_('routeEditor.healthCheckQueryHelp')}</span></div>
              </div>
            </div>
          {/if}
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
