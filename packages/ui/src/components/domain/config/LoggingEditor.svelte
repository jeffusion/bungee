<script lang="ts">
  import { _ } from '$i18n';
  import { Input } from '$components/ui/input';
  import { Button } from '$components/ui/button';
  import { IndustrialToggle } from '$components/industrial';
  import { resolveLoggingBody, withLoggingBody, bytesToKiB, kibToBytes, type LoggingValue, type LoggingBody } from './logging-body';
  let { value = $bindable<Exclude<LoggingValue, null>>(), disabled = false }: { value?: Exclude<LoggingValue, null>; disabled?: boolean } = $props();
  const body = $derived(resolveLoggingBody(value));
  const id = $props.id();
  function editBody(patch: Partial<LoggingBody>) { value = withLoggingBody(value, patch); }
  function sizeChanged(input: HTMLInputElement) {
    if (input.value === '') { input.setCustomValidity(''); editBody({ max_size: undefined }); return; }
    try { editBody({ max_size: kibToBytes(Number(input.value)) }); input.setCustomValidity(''); }
    catch { input.setCustomValidity($_('settings.invalidSize')); input.reportValidity(); }
  }
</script>

<div class="space-y-4">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <div class="space-y-1">
      <label for={`${id}-body`} class="nx-field-label">{$_('logging.bodyRecording')}</label>
      <p class="text-sm text-zinc-400">{$_('logging.bodyRecordingHelp')}</p>
    </div>
    <IndustrialToggle id={`${id}-body`} checked={body.enabled} {disabled} label={$_('logging.bodyRecording')}
      onchange={(enabled) => editBody({ enabled })} />
  </div>
  {#if body.enabled}
    <div class="grid gap-4 sm:grid-cols-2">
      <div class="block space-y-1.5">
        <label class="nx-field-label" id={`${id}-size-label`} for={`${id}-max-size`}>{$_('settings.diff.bodyMax')} · <span class="normal-case">KiB</span></label>
        <Input class="focus-visible:border-nexus-500" id={`${id}-max-size`} aria-labelledby={`${id}-size-label`} data-testid="logging-max-size" type="number" value={bytesToKiB(value?.body?.max_size) ?? ''}
          placeholder={`${$_('settings.useDefault')} (${bytesToKiB(body.max_size)})`} {disabled}
          min="1" max="100" step="any" aria-describedby={`${id}-size-help`} oninput={(e) => sizeChanged(e.currentTarget)} />
        <p id={`${id}-size-help`} class="text-sm text-zinc-400">{$_('settings.bodySizeHelp')}</p>
      </div>
      <div class="block space-y-1.5">
        <label class="nx-field-label" id={`${id}-retention-label`} for={`${id}-retention-days`}>{$_('settings.diff.retention')}</label>
        <Input class="focus-visible:border-nexus-500" id={`${id}-retention-days`} aria-labelledby={`${id}-retention-label`} data-testid="logging-retention-days" type="number" value={value?.body?.retention_days ?? ''}
          placeholder={`${$_('settings.useDefault')} (${body.retention_days})`} {disabled} min="1" max="30" step="1" aria-describedby={`${id}-retention-help`}
          oninput={(e) => editBody({ retention_days: e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value) })} />
        <p id={`${id}-retention-help`} class="text-sm text-zinc-400">{$_('logging.retentionDaysHelp')}</p>
      </div>
    </div>
  {/if}
  <div class="flex flex-wrap items-center gap-3 border-t border-carbon-600 pt-3">
    <p class="text-sm text-zinc-400">{$_('settings.cleanupMoved')}</p>
    <Button href="/#/logs" variant="ghost">{$_('logs.title')}</Button>
  </div>
</div>
