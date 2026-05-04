<script lang="ts">
  import type { FailoverConfig } from '../api/routes';
  import { _ } from '../i18n';

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
    const retryOn = Array.isArray(failover?.retryOn)
      ? failover.retryOn
      : failover?.retryOn !== undefined
        ? [failover.retryOn]
        : [500, 502, 503, 504];
    retryOnInput = retryOn.join(', ');

    consecutiveFailures = failover?.passiveHealth?.consecutiveFailures;
    healthySuccesses = failover?.passiveHealth?.healthySuccesses;
    autoDisableThreshold = failover?.passiveHealth?.autoDisableThreshold;
    autoEnableOnActiveHealthCheck = failover?.passiveHealth?.autoEnableOnActiveHealthCheck ?? true;

    probeIntervalMs = failover?.recovery?.probeIntervalMs;
    probeTimeoutMs = failover?.recovery?.probeTimeoutMs;

    healthCheckEnabled = failover?.healthCheck?.enabled ?? false;
    healthCheckIntervalMs = failover?.healthCheck?.intervalMs;
    healthCheckTimeoutMs = failover?.healthCheck?.timeoutMs;
    healthCheckPath = failover?.healthCheck?.path;
    healthCheckMethod = failover?.healthCheck?.method;
    healthCheckBody = failover?.healthCheck?.body;
    healthCheckContentType = failover?.healthCheck?.contentType;
    healthCheckHeadersInput = formatKeyValuePairs(failover?.healthCheck?.headers);
    healthCheckQueryInput = formatKeyValuePairs(failover?.healthCheck?.query);
    healthCheckExpectedStatusInput = (failover?.healthCheck?.expectedStatus || [200]).join(', ');
    healthCheckUnhealthyThreshold = failover?.healthCheck?.unhealthyThreshold;
    healthCheckHealthyThreshold = failover?.healthCheck?.healthyThreshold;

    slowStartEnabled = failover?.slowStart?.enabled ?? false;
    slowStartDurationMs = failover?.slowStart?.durationMs;
    slowStartInitialWeightFactor = failover?.slowStart?.initialWeightFactor;
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
      retryOn: retryOn.length > 0 ? retryOn : [500, 502, 503, 504],
      passiveHealth: compactObject({
        consecutiveFailures,
        healthySuccesses,
        autoDisableThreshold,
        autoEnableOnActiveHealthCheck,
      }),
      recovery: compactObject({
        probeIntervalMs,
        probeTimeoutMs,
      }),
      slowStart: slowStartEnabled
        ? compactObject({
            enabled: true,
            durationMs: slowStartDurationMs,
            initialWeightFactor: slowStartInitialWeightFactor,
          })
        : undefined,
      healthCheck: healthCheckEnabled
        ? compactObject({
            enabled: true,
            intervalMs: healthCheckIntervalMs,
            timeoutMs: healthCheckTimeoutMs,
            path: healthCheckPath,
            method: healthCheckMethod,
            body: healthCheckBody,
            contentType: healthCheckContentType,
            headers: healthCheckHeaders,
            query: healthCheckQuery,
            expectedStatus: expectedStatus.length > 0 ? expectedStatus : [200],
            unhealthyThreshold: healthCheckUnhealthyThreshold,
            healthyThreshold: healthCheckHealthyThreshold,
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

<div class="form-control w-full">
  <div class="label">
    <span class="label-text font-semibold">{label}</span>
    {#if showHelp}
      <span class="label-text-alt text-xs">{$_('routeEditor.failoverHelp')}</span>
    {/if}
  </div>

  <div class="space-y-4">
    <div class="form-control">
      <label class="label cursor-pointer justify-start gap-4">
        <input type="checkbox" class="checkbox" bind:checked={enabled} on:change={syncModel} />
        <span class="label-text">{$_('routeEditor.enableFailover')}</span>
      </label>
    </div>

    {#if enabled}
      <div class="form-control">
        <label class="label" for="failover-status-codes">
          <span class="label-text">{$_('routeEditor.retryableStatusCodes')}</span>
        </label>
        <input id="failover-status-codes" type="text" placeholder={$_('routeEditor.retryableStatusCodesPlaceholder')} class="input input-bordered input-sm" bind:value={retryOnInput} on:input={syncModel} />
        <div class="label">
          <span class="label-text-alt text-xs">{$_('routeEditor.retryableStatusCodesHelp')}</span>
        </div>
      </div>

      <div class="collapse collapse-arrow bg-base-200">
        <input type="checkbox" />
        <div class="collapse-title text-sm font-medium">{$_('routeEditor.passiveHealthCheck')}</div>
        <div class="collapse-content space-y-4">
          <div class="text-xs text-base-content/60 bg-base-300 rounded p-2">{$_('routeEditor.passiveHealthCheckTooltip')}</div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div class="form-control">
              <label class="label" for="consecutive-failures-threshold"><span class="label-text">{$_('routeEditor.consecutiveFailuresThreshold')}</span></label>
              <input id="consecutive-failures-threshold" type="number" placeholder="3" class="input input-bordered input-sm" bind:value={consecutiveFailures} min="1" on:input={syncModel} />
              <div class="label"><span class="label-text-alt text-xs">{$_('routeEditor.consecutiveFailuresThresholdHelp')}</span></div>
            </div>

            <div class="form-control">
              <label class="label" for="recovery-interval-ms"><span class="label-text">{$_('routeEditor.recoveryIntervalMs')}</span></label>
              <input id="recovery-interval-ms" type="number" placeholder="5000" class="input input-bordered input-sm" bind:value={probeIntervalMs} min="1000" on:input={syncModel} />
              <div class="label"><span class="label-text-alt text-xs">{$_('routeEditor.recoveryIntervalHelp')}</span></div>
            </div>

            <div class="form-control">
              <label class="label" for="healthy-threshold"><span class="label-text">{$_('routeEditor.healthyThreshold')}</span></label>
              <input id="healthy-threshold" type="number" placeholder="2" class="input input-bordered input-sm" bind:value={healthySuccesses} min="1" on:input={syncModel} />
              <div class="label"><span class="label-text-alt text-xs">{$_('routeEditor.healthyThresholdHelp')}</span></div>
            </div>

            <div class="form-control">
              <label class="label" for="recovery-timeout-ms"><span class="label-text">{$_('routeEditor.recoveryTimeoutMs')}</span></label>
              <input id="recovery-timeout-ms" type="number" placeholder="3000" class="input input-bordered input-sm" bind:value={probeTimeoutMs} min="100" on:input={syncModel} />
              <div class="label"><span class="label-text-alt text-xs">{$_('routeEditor.recoveryTimeoutHelp')}</span></div>
            </div>

            <div class="form-control">
              <label class="label" for="auto-disable-threshold"><span class="label-text">{$_('routeEditor.autoDisableThreshold')}</span></label>
              <input id="auto-disable-threshold" type="number" placeholder={$_('routeEditor.autoDisableThresholdPlaceholder')} class="input input-bordered input-sm" bind:value={autoDisableThreshold} min="1" on:input={syncModel} />
              <div class="label"><span class="label-text-alt text-xs">{$_('routeEditor.autoDisableThresholdHelp')}</span></div>
            </div>

            <div class="form-control">
              <label class="label cursor-pointer justify-start gap-2">
                <input type="checkbox" class="checkbox checkbox-sm" bind:checked={autoEnableOnActiveHealthCheck} on:change={syncModel} />
                <span class="label-text">{$_('routeEditor.autoEnableOnHealthCheck')}</span>
              </label>
              <div class="label"><span class="label-text-alt text-xs">{$_('routeEditor.autoEnableOnHealthCheckHelp')}</span></div>
            </div>
          </div>
        </div>
      </div>

      <div class="collapse collapse-arrow bg-base-200">
        <input type="checkbox" />
        <div class="collapse-title text-sm font-medium">{$_('routeEditor.activeHealthCheck')}</div>
        <div class="collapse-content space-y-4">
          <div class="text-xs text-base-content/60 bg-base-300 rounded p-2">{$_('routeEditor.activeHealthCheckTooltip')}</div>
          <div class="form-control">
            <label class="label cursor-pointer justify-start gap-4">
              <input type="checkbox" class="checkbox checkbox-sm" bind:checked={healthCheckEnabled} on:change={syncModel} />
              <span class="label-text">{$_('routeEditor.enableActiveHealthCheck')}</span>
            </label>
          </div>

          {#if healthCheckEnabled}
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div class="form-control">
                <label class="label" for="health-check-interval-ms"><span class="label-text">{$_('routeEditor.healthCheckIntervalMs')}</span></label>
                <input id="health-check-interval-ms" type="number" placeholder="10000" class="input input-bordered input-sm" bind:value={healthCheckIntervalMs} min="1000" on:input={syncModel} />
                <div class="label"><span class="label-text-alt text-xs">{$_('routeEditor.healthCheckIntervalMsHelp')}</span></div>
              </div>

              <div class="form-control">
                <label class="label" for="health-check-timeout-ms"><span class="label-text">{$_('routeEditor.healthCheckTimeoutMs')}</span></label>
                <input id="health-check-timeout-ms" type="number" placeholder="3000" class="input input-bordered input-sm" bind:value={healthCheckTimeoutMs} min="100" on:input={syncModel} />
                <div class="label"><span class="label-text-alt text-xs">{$_('routeEditor.healthCheckTimeoutMsHelp')}</span></div>
              </div>

              <div class="form-control">
                <label class="label" for="health-check-path"><span class="label-text">{$_('routeEditor.healthCheckPath')}</span></label>
                <input id="health-check-path" type="text" placeholder="/health" class="input input-bordered input-sm" bind:value={healthCheckPath} on:input={syncModel} />
                <div class="label"><span class="label-text-alt text-xs">{$_('routeEditor.healthCheckPathHelp')}</span></div>
              </div>

              <div class="form-control">
                <label class="label" for="health-check-method"><span class="label-text">{$_('routeEditor.healthCheckMethod')}</span></label>
                <input id="health-check-method" type="text" placeholder="GET" class="input input-bordered input-sm" bind:value={healthCheckMethod} on:input={syncModel} />
              </div>

              <div class="form-control">
                <label class="label" for="health-check-expected-status"><span class="label-text">{$_('routeEditor.healthCheckExpectedStatus')}</span></label>
                <input id="health-check-expected-status" type="text" placeholder="200" class="input input-bordered input-sm" bind:value={healthCheckExpectedStatusInput} on:input={syncModel} />
                <div class="label"><span class="label-text-alt text-xs">{$_('routeEditor.healthCheckExpectedStatusHelp')}</span></div>
              </div>

              <div class="form-control">
                <label class="label" for="health-check-unhealthy-threshold"><span class="label-text">{$_('routeEditor.healthCheckUnhealthyThreshold')}</span></label>
                <input id="health-check-unhealthy-threshold" type="number" placeholder="3" class="input input-bordered input-sm" bind:value={healthCheckUnhealthyThreshold} min="1" on:input={syncModel} />
                <div class="label"><span class="label-text-alt text-xs">{$_('routeEditor.healthCheckUnhealthyThresholdHelp')}</span></div>
              </div>

              <div class="form-control">
                <label class="label" for="health-check-healthy-threshold"><span class="label-text">{$_('routeEditor.healthCheckHealthyThreshold')}</span></label>
                <input id="health-check-healthy-threshold" type="number" placeholder="2" class="input input-bordered input-sm" bind:value={healthCheckHealthyThreshold} min="1" on:input={syncModel} />
                <div class="label"><span class="label-text-alt text-xs">{$_('routeEditor.healthCheckHealthyThresholdHelp')}</span></div>
              </div>

              <div class="form-control">
                <label class="label" for="health-check-content-type"><span class="label-text">{$_('routeEditor.healthCheckContentType')}</span></label>
                <input id="health-check-content-type" type="text" placeholder="application/json" class="input input-bordered input-sm" bind:value={healthCheckContentType} on:input={syncModel} />
                <div class="label"><span class="label-text-alt text-xs">{$_('routeEditor.healthCheckContentTypeHelp')}</span></div>
              </div>
            </div>

            <div class="form-control">
              <label class="label" for="health-check-body"><span class="label-text">{$_('routeEditor.healthCheckBody')}</span></label>
              <textarea id="health-check-body" rows="4" class="textarea textarea-bordered textarea-sm" bind:value={healthCheckBody} placeholder={$_('routeEditor.healthCheckBodyPlaceholder')} on:input={syncModel}></textarea>
              <div class="label"><span class="label-text-alt text-xs">{$_('routeEditor.healthCheckBodyHelp')}</span></div>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div class="form-control">
                <label class="label" for="health-check-headers"><span class="label-text">{$_('routeEditor.healthCheckHeaders')}</span></label>
                <textarea id="health-check-headers" rows="4" class="textarea textarea-bordered textarea-sm font-mono" bind:value={healthCheckHeadersInput} placeholder={$_('routeEditor.healthCheckHeadersPlaceholder')} on:input={syncModel}></textarea>
                <div class="label"><span class="label-text-alt text-xs">{$_('routeEditor.healthCheckHeadersHelp')}</span></div>
              </div>

              <div class="form-control">
                <label class="label" for="health-check-query"><span class="label-text">{$_('routeEditor.healthCheckQuery')}</span></label>
                <textarea id="health-check-query" rows="4" class="textarea textarea-bordered textarea-sm font-mono" bind:value={healthCheckQueryInput} placeholder={$_('routeEditor.healthCheckQueryPlaceholder')} on:input={syncModel}></textarea>
                <div class="label"><span class="label-text-alt text-xs">{$_('routeEditor.healthCheckQueryHelp')}</span></div>
              </div>
            </div>
          {/if}
        </div>
      </div>

      <div class="collapse collapse-arrow bg-base-200">
        <input type="checkbox" />
        <div class="collapse-title text-sm font-medium">{$_('routeEditor.slowStart')}</div>
        <div class="collapse-content space-y-4">
          <div class="text-xs text-base-content/60 bg-base-300 rounded p-2">{$_('routeEditor.slowStartTooltip')}</div>
          <div class="form-control">
            <label class="label cursor-pointer justify-start gap-4">
              <input type="checkbox" class="checkbox checkbox-sm" bind:checked={slowStartEnabled} on:change={syncModel} />
              <span class="label-text">{$_('routeEditor.enableSlowStart')}</span>
            </label>
          </div>

          {#if slowStartEnabled}
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div class="form-control">
                <label class="label" for="slow-start-duration-ms"><span class="label-text">{$_('routeEditor.slowStartDurationMs')}</span></label>
                <input id="slow-start-duration-ms" type="number" placeholder="30000" class="input input-bordered input-sm" bind:value={slowStartDurationMs} min="1000" on:input={syncModel} />
                <div class="label"><span class="label-text-alt text-xs">{$_('routeEditor.slowStartDurationMsHelp')}</span></div>
              </div>

              <div class="form-control">
                <label class="label" for="slow-start-initial-weight-factor"><span class="label-text">{$_('routeEditor.slowStartInitialWeightFactor')}</span></label>
                <input id="slow-start-initial-weight-factor" type="number" placeholder="0.1" class="input input-bordered input-sm" bind:value={slowStartInitialWeightFactor} min="0.01" max="1" step="0.01" on:input={syncModel} />
                <div class="label"><span class="label-text-alt text-xs">{$_('routeEditor.slowStartInitialWeightFactorHelp')}</span></div>
              </div>
            </div>
          {/if}
        </div>
      </div>
    {/if}
  </div>
</div>
