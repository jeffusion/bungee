<script lang="ts">
  import { _ } from '$i18n';
  import { NumberInput } from '$components/ui/number-input';
  import { Button } from '$components/ui/button';
  import { IndustrialToggle } from '$components/industrial';
  import { resolveLoggingBody, withLoggingBody, bytesToKiB, kibToBytes, type LoggingValue, type LoggingBody } from './logging-body';
  let { value = $bindable<Exclude<LoggingValue, null>>(), disabled = false }: { value?: Exclude<LoggingValue, null>; disabled?: boolean } = $props();
  const body = $derived(resolveLoggingBody(value));
  const id = $props.id();
  let sizeKib = $state<number | undefined>(bytesToKiB(value?.body?.max_size));
  let sizeInvalid = $state(false);
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
  <div class="flex flex-wrap items-center justify-between gap-3">
    <div class="space-y-1">
      <label for={`${id}-body`} class="nx-field-label">{$_('logging.bodyRecording')}</label>
      <p class="text-sm text-zinc-400">{$_('logging.bodyRecordingHelp')}</p>
    </div>
    <IndustrialToggle id={`${id}-body`} checked={body.enabled} {disabled} label={$_('logging.bodyRecording')}
      onchange={bodyEnabled} />
  </div>
  {#if body.enabled}
    <div class="grid gap-4 sm:grid-cols-2">
      <div class="block space-y-1.5">
        <label class="nx-field-label" id={`${id}-size-label`} for={`${id}-max-size`}>{$_('settings.diff.bodyMax')} · <span class="normal-case">KiB</span></label>
        <NumberInput class="focus-visible:border-nexus-500" id={`${id}-max-size`} aria-labelledby={`${id}-size-label`} data-testid="logging-max-size"
          step="any" min={1} max={5120}
          bind:value={() => sizeKib, sizeChanged}
          placeholder={`${$_('settings.useDefault')} (${bytesToKiB(body.max_size)})`} {disabled}
          invalid={sizeInvalid} aria-describedby={`${id}-size-help${sizeInvalid ? ` ${id}-size-error` : ''}`}
          increaseLabel={$_('settings.increaseBodySize')} decreaseLabel={$_('settings.decreaseBodySize')}
          invalidMessage={$_('settings.invalidSize')} />
        <p id={`${id}-size-help`} class="text-sm text-zinc-400">{$_('settings.bodySizeHelp')}</p>
        {#if sizeInvalid}<p id={`${id}-size-error`} role="alert" class="text-sm text-red-400">{$_('settings.invalidSize')}</p>{/if}
      </div>
      <div class="block space-y-1.5">
        <label class="nx-field-label" id={`${id}-retention-label`} for={`${id}-retention-days`}>{$_('settings.diff.retention')}</label>
        <NumberInput id={`${id}-retention-days`} aria-labelledby={`${id}-retention-label`} data-testid="logging-retention-days"
          min={1} max={30}
          bind:value={() => value?.body?.retention_days, (days) => { if (value?.body?.retention_days !== days) editBody({ retention_days: days }); }}
          placeholder={`${$_('settings.useDefault')} (${body.retention_days})`} {disabled} aria-describedby={`${id}-retention-help`}
          increaseLabel={$_('settings.increaseRetention')} decreaseLabel={$_('settings.decreaseRetention')}
          invalidMessage={$_('settings.retentionInvalid')} />
        <p id={`${id}-retention-help`} class="text-sm text-zinc-400">{$_('logging.retentionDaysHelp')}</p>
      </div>
    </div>
  {/if}
  <div class="flex flex-wrap items-center gap-3 border-t border-carbon-600 pt-3">
    <p class="text-sm text-zinc-400">{$_('settings.cleanupMoved')}</p>
    <Button href="/#/logs" variant="ghost">{$_('logs.title')}</Button>
  </div>
</div>
