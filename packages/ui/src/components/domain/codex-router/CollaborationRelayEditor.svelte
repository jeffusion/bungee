<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { _, isLoading } from '$i18n';
  import { getPluginText } from '$utils/plugin-i18n';
  import { IndustrialToggle, LoadingIndicator } from '$components/industrial';
  import { Button } from '$components/ui/button';
  import { Input } from '$components/ui/input';
  import { Label } from '$components/ui/label';
  import CodexTargetPicker from './CodexTargetPicker.svelte';
  import { loadCodexGatewayTargets, type CodexGatewayTarget } from './gateway-targets';

  type RelayDraft = { target?: { type: 'route' | 'service'; id: string; protocol?: string }; model?: string };
  let { value, onchange, onvalidate }: { value?: RelayDraft; onchange: (value: RelayDraft | undefined) => void; onvalidate: (error: string | null) => void } = $props();
  const id = `codex-relay-${Math.random().toString(36).slice(2, 10)}`;
  const t = (key: string) => $isLoading ? '' : getPluginText(key, 'codex-router', (key, options) => $_(key, options));
  let targets = $state<CodexGatewayTarget[]>([]), loading = $state(true), failed = $state(false);
  let alive = false;
  let validation = $derived.by(() => {
    if (!value) return null;
    if (loading || failed || !targets.some(target => target.type === value.target?.type && target.id === value.target?.id)) return t('relay.targetRequired');
    if (value.target?.protocol !== 'responses') return t('relay.protocolInvalid');
    if (typeof value.model !== 'string' || !value.model || value.model !== value.model.trim() || value.model.length > 512) return t('relay.modelInvalid');
    return null;
  });
  $effect(() => { if (!$isLoading) { const next = validation; untrack(() => onvalidate(next)); } });
  async function loadTargets() {
    loading = true; failed = false;
    try { const next = await loadCodexGatewayTargets(); if (alive) targets = next; }
    catch { if (alive) failed = true; }
    finally { if (alive) loading = false; }
  }
  onMount(() => { alive = true; void loadTargets(); return () => { alive = false; }; });
</script>

<div class="min-w-0 space-y-4" data-testid="codex-collaboration-relay">
  <div class="flex items-center justify-between gap-3">
    <Label for={`${id}-enabled`}>{t('relay.label')}</Label>
    <IndustrialToggle id={`${id}-enabled`} label={t('relay.label')} checked={value !== undefined}
      onchange={enabled => onchange(enabled ? { target: { type: 'route', id: '', protocol: 'responses' }, model: '' } : undefined)} />
  </div>
  {#if value !== undefined}
    <div class="min-w-0 space-y-4 border-l-2 border-nexus-500/40 pl-4">
      {#if loading}<LoadingIndicator label={t('editor.loading')} />{/if}
      {#if failed}<p role="alert" class="text-sm text-red-400">{t('editor.targetsError')}</p><Button variant="outline" onclick={() => void loadTargets()}>{t('editor.retry')}</Button>{/if}
      <CodexTargetPicker id={`${id}-target`} label={t('relay.target')} value={value.target} {targets} {loading} error={failed}
        onchange={target => onchange({ ...value, target: { ...target, protocol: 'responses' } })} />
      <div class="space-y-2">
        <Label for={`${id}-model`}>{t('relay.model')}</Label>
        <Input id={`${id}-model`} value={value.model ?? ''} maxlength={512} required placeholder={t('relay.modelPlaceholder')}
          oninput={event => onchange({ ...value, model: event.currentTarget.value })} />
      </div>
      <div class="space-y-2"><span class="nx-field-label">{t('editor.targetProtocol')}</span><p class="text-sm text-zinc-200">Responses</p></div>
    </div>
  {/if}
</div>
