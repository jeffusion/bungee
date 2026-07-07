<script lang="ts">
  import type { ServiceHealthCheckConfig } from '$api/routes';
  import { _ } from '$i18n';
  import { BSwitch } from '$components/industrial';
  import { Input } from '$components/ui/input';
  import { Textarea } from '$components/ui/textarea';

  export let health_check: ServiceHealthCheckConfig | undefined = undefined;

  let initialized = false;
  let enabled = false;

  let intervalMs: number | undefined;
  let timeoutMs: number | undefined;
  let path: string | undefined;
  let method: string | undefined;
  let body: string | undefined;
  let contentType: string | undefined;
  let headersInput = '';
  let queryInput = '';
  let expectedStatusInput = '';
  let unhealthyThreshold: number | undefined;
  let healthyThreshold: number | undefined;
  let autoEnableOnActiveHealthCheck = true;

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
    enabled = health_check?.enabled ?? false;
    intervalMs = health_check?.interval_ms;
    timeoutMs = health_check?.timeout_ms;
    path = health_check?.path;
    method = health_check?.method;
    body = health_check?.body;
    contentType = health_check?.content_type;
    headersInput = formatKeyValuePairs(health_check?.headers);
    queryInput = formatKeyValuePairs(health_check?.query);
    expectedStatusInput = (health_check?.expected_status || [200]).join(', ');
    unhealthyThreshold = health_check?.unhealthy_threshold;
    healthyThreshold = health_check?.healthy_threshold;
    autoEnableOnActiveHealthCheck = health_check?.auto_enable_on_active_health_check ?? true;
  }

  function syncModel(): void {
    if (!enabled) {
      health_check = undefined;
      return;
    }

    const expectedStatus = parseNumberStatusCodes(expectedStatusInput);
    const headers = parseKeyValuePairs(headersInput);
    const query = parseKeyValuePairs(queryInput);

    health_check = compactObject({
      enabled: true,
      interval_ms: intervalMs,
      timeout_ms: timeoutMs,
      path,
      method,
      body,
      content_type: contentType,
      headers,
      query,
      expected_status: expectedStatus.length > 0 ? expectedStatus : [200],
      unhealthy_threshold: unhealthyThreshold,
      healthy_threshold: healthyThreshold,
      auto_enable_on_active_health_check: autoEnableOnActiveHealthCheck,
    });
  }

  $: if (!initialized) {
    initializeFromProps();
    initialized = true;
    syncModel();
  }
</script>

<div class="w-full space-y-1" data-testid="service-health-check-section">
  <div class="block">
    <span class="nx-label-sm font-semibold">{$_('routeEditor.activeHealthCheck')}</span>
    <span class="font-mono text-[11px] uppercase tracking-command text-zinc-500">{$_('routeEditor.activeHealthCheckTooltip')}</span>
  </div>

  <div class="space-y-1.5">
    <BSwitch
      checked={enabled}
      onchange={(v) => { enabled = v; syncModel(); }}
      label={$_('routeEditor.enableActiveHealthCheck')}
      size="small"
      showChildren={false}
    />
  </div>

  {#if enabled}
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
      <div class="space-y-1.5">
        <label class="block" for="health-check-path"><span class="nx-label-sm">{$_('routeEditor.healthCheckPath')}</span></label>
        <Input id="health-check-path" type="text" placeholder="/health" value={path ?? ''} oninput={(e) => { path = (e.target as HTMLInputElement).value; syncModel(); }} />
        <div class="block"><span class="font-mono text-[11px] uppercase tracking-command text-zinc-500">{$_('routeEditor.healthCheckPathHelp')}</span></div>
      </div>

      <div class="space-y-1.5">
        <label class="block" for="health-check-interval-ms"><span class="nx-label-sm">{$_('routeEditor.healthCheckIntervalMs')}</span></label>
        <Input id="health-check-interval-ms" type="number" placeholder="10000" value={intervalMs ?? ''} oninput={(e) => { intervalMs = (e.target as HTMLInputElement).value ? Number((e.target as HTMLInputElement).value) : undefined; syncModel(); }} min="1000" />
        <div class="block"><span class="font-mono text-[11px] uppercase tracking-command text-zinc-500">{$_('routeEditor.healthCheckIntervalMsHelp')}</span></div>
      </div>

      <div class="space-y-1.5">
        <label class="block" for="health-check-timeout-ms"><span class="nx-label-sm">{$_('routeEditor.healthCheckTimeoutMs')}</span></label>
        <Input id="health-check-timeout-ms" type="number" placeholder="3000" value={timeoutMs ?? ''} oninput={(e) => { timeoutMs = (e.target as HTMLInputElement).value ? Number((e.target as HTMLInputElement).value) : undefined; syncModel(); }} min="100" />
        <div class="block"><span class="font-mono text-[11px] uppercase tracking-command text-zinc-500">{$_('routeEditor.healthCheckTimeoutMsHelp')}</span></div>
      </div>

      <div class="space-y-1.5">
        <label class="block" for="health-check-method"><span class="nx-label-sm">{$_('routeEditor.healthCheckMethod')}</span></label>
        <Input id="health-check-method" type="text" placeholder="GET" value={method ?? ''} oninput={(e) => { method = (e.target as HTMLInputElement).value; syncModel(); }} />
      </div>

      <div class="space-y-1.5">
        <label class="block" for="health-check-expected-status"><span class="nx-label-sm">{$_('routeEditor.healthCheckExpectedStatus')}</span></label>
        <Input id="health-check-expected-status" type="text" placeholder="200" value={expectedStatusInput} oninput={(e) => { expectedStatusInput = (e.target as HTMLInputElement).value; syncModel(); }} />
        <div class="block"><span class="font-mono text-[11px] uppercase tracking-command text-zinc-500">{$_('routeEditor.healthCheckExpectedStatusHelp')}</span></div>
      </div>

      <div class="space-y-1.5">
        <label class="block" for="health-check-unhealthy-threshold"><span class="nx-label-sm">{$_('routeEditor.healthCheckUnhealthyThreshold')}</span></label>
        <Input id="health-check-unhealthy-threshold" type="number" placeholder="3" value={unhealthyThreshold ?? ''} oninput={(e) => { unhealthyThreshold = (e.target as HTMLInputElement).value ? Number((e.target as HTMLInputElement).value) : undefined; syncModel(); }} min="1" />
        <div class="block"><span class="font-mono text-[11px] uppercase tracking-command text-zinc-500">{$_('routeEditor.healthCheckUnhealthyThresholdHelp')}</span></div>
      </div>

      <div class="space-y-1.5">
        <label class="block" for="health-check-healthy-threshold"><span class="nx-label-sm">{$_('routeEditor.healthCheckHealthyThreshold')}</span></label>
        <Input id="health-check-healthy-threshold" type="number" placeholder="2" value={healthyThreshold ?? ''} oninput={(e) => { healthyThreshold = (e.target as HTMLInputElement).value ? Number((e.target as HTMLInputElement).value) : undefined; syncModel(); }} min="1" />
        <div class="block"><span class="font-mono text-[11px] uppercase tracking-command text-zinc-500">{$_('routeEditor.healthCheckHealthyThresholdHelp')}</span></div>
      </div>

      <div class="space-y-1.5">
        <label class="block" for="health-check-content-type"><span class="nx-label-sm">{$_('routeEditor.healthCheckContentType')}</span></label>
        <Input id="health-check-content-type" type="text" placeholder="application/json" value={contentType ?? ''} oninput={(e) => { contentType = (e.target as HTMLInputElement).value; syncModel(); }} />
        <div class="block"><span class="font-mono text-[11px] uppercase tracking-command text-zinc-500">{$_('routeEditor.healthCheckContentTypeHelp')}</span></div>
      </div>
    </div>

    <div class="space-y-1.5">
      <label class="block" for="health-check-body"><span class="nx-label-sm">{$_('routeEditor.healthCheckBody')}</span></label>
      <Textarea id="health-check-body" rows="4" class="resize-y" value={body ?? ''} oninput={(e) => { body = (e.target as HTMLTextAreaElement).value; syncModel(); }} placeholder={$_('routeEditor.healthCheckBodyPlaceholder')} />
      <div class="block"><span class="font-mono text-[11px] uppercase tracking-command text-zinc-500">{$_('routeEditor.healthCheckBodyHelp')}</span></div>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div class="space-y-1.5">
        <label class="block" for="health-check-headers"><span class="nx-label-sm">{$_('routeEditor.healthCheckHeaders')}</span></label>
        <Textarea id="health-check-headers" rows="4" class="resize-y font-mono" value={headersInput} oninput={(e) => { headersInput = (e.target as HTMLTextAreaElement).value; syncModel(); }} placeholder={$_('routeEditor.healthCheckHeadersPlaceholder')} />
        <div class="block"><span class="font-mono text-[11px] uppercase tracking-command text-zinc-500">{$_('routeEditor.healthCheckHeadersHelp')}</span></div>
      </div>

      <div class="space-y-1.5">
        <label class="block" for="health-check-query"><span class="nx-label-sm">{$_('routeEditor.healthCheckQuery')}</span></label>
        <Textarea id="health-check-query" rows="4" class="resize-y font-mono" value={queryInput} oninput={(e) => { queryInput = (e.target as HTMLTextAreaElement).value; syncModel(); }} placeholder={$_('routeEditor.healthCheckQueryPlaceholder')} />
        <div class="block"><span class="font-mono text-[11px] uppercase tracking-command text-zinc-500">{$_('routeEditor.healthCheckQueryHelp')}</span></div>
      </div>
    </div>

    <div class="space-y-1.5 pt-2">
      <BSwitch
        checked={autoEnableOnActiveHealthCheck}
        onchange={(v) => { autoEnableOnActiveHealthCheck = v; syncModel(); }}
        label={$_('routeEditor.autoEnableOnHealthCheck')}
        size="small"
        showChildren={false}
      />
      <div class="block"><span class="font-mono text-[11px] uppercase tracking-command text-zinc-500">{$_('routeEditor.autoEnableOnHealthCheckHelp')}</span></div>
    </div>
  {/if}
</div>
