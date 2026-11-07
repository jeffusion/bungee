<script lang="ts">
  import { _ } from '$i18n';
  import { NumberInput } from '$components/ui/number-input';
  import { IndustrialToggle } from '$components/industrial';
  import { LOGGING_BODY_DEFAULTS, withLoggingBody, bytesToKiB, kibToBytes, type LoggingValue, type LoggingBody } from './logging-body';
  let { value = $bindable<Exclude<LoggingValue, null>>(), invalid = $bindable(false), disabled = false }:
    { value?: Exclude<LoggingValue, null>; invalid?: boolean; disabled?: boolean } = $props();
  const enabled = $derived(value?.body?.enabled ?? LOGGING_BODY_DEFAULTS.enabled);
  const id = $props.id();
  let sizeKib = $state<number | undefined>(bytesToKiB(value?.body?.max_size));
  let sizeInvalid = $state(false);
  $effect(() => { invalid = sizeInvalid; });
  let committedSize = value?.body?.max_size;
  // Show an invalid entry until it is corrected; only an accepted size is written back.
  $effect(() => {
    const next = value?.body?.max_size;
    if (next !== committedSize) {
      committedSize = next;
      sizeKib = bytesToKiB(next);
      sizeInvalid = false;
    }
  });
  function editBody(patch: Partial<LoggingBody>) { value = withLoggingBody(value, patch); }
  function sizeChanged(kib: number | undefined) {
    sizeKib = kib;
    sizeInvalid = false;
    if (kib === undefined) {
      if (value?.body?.max_size !== undefined) editBody({ max_size: undefined });
      return;
    }
    let bytes: number;
    try { bytes = kibToBytes(kib); }
    catch { sizeInvalid = true; return; }
    if (value?.body?.max_size !== bytes) editBody({ max_size: bytes });
  }
  function bodyEnabled(enabled: boolean) {
    if (!enabled) { sizeKib = bytesToKiB(value?.body?.max_size); sizeInvalid = false; }
    editBody({ enabled });
  }
</script>

<div class="space-y-4">
  <div class="space-y-1.5">
    <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
      <label for={`${id}-body`} class="text-sm font-medium text-zinc-100">{$_('logging.bodyRecording')}</label>
      <IndustrialToggle id={`${id}-body`} checked={enabled} {disabled} label={$_('logging.bodyRecording')}
        onchange={bodyEnabled} />
    </div>
    <p class="text-sm text-zinc-400">{$_('logging.bodyRecordingHelp')}</p>
  </div>
  {#if enabled}
    <div class="grid items-start gap-2 sm:grid-cols-[minmax(0,1fr)_11rem] sm:gap-x-6">
      <div class="space-y-1">
        <label class="text-sm font-medium text-zinc-100" for={`${id}-max-size`}>{$_('settings.diff.bodyMax')} <span class="font-mono text-xs text-zinc-400">(KiB)</span></label>
        <p id={`${id}-size-help`} class="text-sm text-zinc-400">{$_('settings.bodySizeHelp', { values: { value: bytesToKiB(LOGGING_BODY_DEFAULTS.max_size) } })}</p>
      </div>
      <div class="w-full max-w-44 space-y-1">
        <NumberInput id={`${id}-max-size`} data-testid="logging-max-size"
          step="any" min={1} max={Number.MAX_SAFE_INTEGER / 1024}
          bind:value={() => sizeKib, sizeChanged}
          placeholder={$_('logging.defaultBodySize', { values: { value: bytesToKiB(LOGGING_BODY_DEFAULTS.max_size) } })} {disabled}
          invalid={sizeInvalid} aria-describedby={`${id}-size-help${sizeInvalid ? ` ${id}-size-error` : ''}`}
          increaseLabel={$_('settings.increaseBodySize')} decreaseLabel={$_('settings.decreaseBodySize')}
          invalidMessage={$_('settings.invalidSize')} />
        {#if sizeInvalid}<p id={`${id}-size-error`} role="alert" class="text-sm text-red-400">{$_('settings.invalidSize')}</p>{/if}
      </div>
    </div>
  {/if}
  <div class="grid items-start gap-2 border-t border-carbon-600 pt-4 sm:grid-cols-[minmax(0,1fr)_11rem] sm:gap-x-6">
    <div class="space-y-1">
      <label class="text-sm font-medium text-zinc-100" for={`${id}-retention-days`}>{$_('settings.diff.retention')} <span class="text-xs text-zinc-400">({$_('logging.days')})</span></label>
      <p id={`${id}-retention-help`} class="text-sm text-zinc-400">{$_('logging.retentionDaysHelp', { values: { value: LOGGING_BODY_DEFAULTS.retention_days } })}</p>
    </div>
    <div class="w-full max-w-44">
      <NumberInput id={`${id}-retention-days`} data-testid="logging-retention-days"
        min={1} max={30}
        bind:value={() => value?.body?.retention_days, (days) => { if (value?.body?.retention_days !== days) editBody({ retention_days: days }); }}
        placeholder={$_('logging.defaultRetentionDays', { values: { value: LOGGING_BODY_DEFAULTS.retention_days } })} {disabled} aria-describedby={`${id}-retention-help`}
        increaseLabel={$_('settings.increaseRetention')} decreaseLabel={$_('settings.decreaseRetention')}
        invalidMessage={$_('settings.retentionInvalid')} />
    </div>
  </div>
</div>
