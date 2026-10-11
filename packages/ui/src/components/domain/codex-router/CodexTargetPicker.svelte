<script lang="ts">
  import { _, isLoading } from '$i18n';
  import { getPluginText } from '$utils/plugin-i18n';
  import { BSelect } from '$components/industrial';
  import { Label } from '$components/ui/label';
  import type { CodexGatewayTarget } from './gateway-targets';

  let { id, label, value, targets, loading = false, error = false, onchange }:
    { id: string; label: string; value?: { type: 'route' | 'service'; id: string }; targets: CodexGatewayTarget[];
      loading?: boolean; error?: boolean; onchange: (target: { type: 'route' | 'service'; id: string }) => void } = $props();
  const t = (key: string) => $isLoading ? '' : getPluginText(`editor.${key}`, 'codex-router', (key, options) => $_(key, options));
  const typeOptions = $derived((['route', 'service'] as const).map(type => ({ value: type, label: t(type) })));
  const targetType = $derived(value?.type === 'route' || value?.type === 'service' ? value.type : '');
  const options = $derived.by(() => {
    const result = targets.filter(target => target.type === targetType).map(target => ({ value: target.id, label: target.label, disabled: false }));
    if (targetType && value?.id && !result.some(option => option.value === value.id)) {
      result.push({ value: value.id, label: `${value.id}${loading ? '' : ` · ${t('targetUnavailable')}`}`, disabled: true });
    }
    return result;
  });
</script>

<div class="grid min-w-0 gap-3 sm:grid-cols-2">
  <div class="min-w-0 space-y-1.5">
    <Label class="block" for={`${id}-type`}>{t('targetType')}</Label>
    <BSelect id={`${id}-type`} searchable searchLabels={{ empty: t('noOptions') }} value={targetType}
      options={typeOptions} ariaLabel={t('targetType')} placeholder={t('targetTypePlaceholder')}
      onchange={type => { if ((type === 'route' || type === 'service') && type !== targetType) onchange({ type, id: '' }); }} />
  </div>
  <div class="min-w-0 space-y-1.5">
    <Label class="block" for={id}>{label}</Label>
    <BSelect {id} searchable searchLabels={{ empty: t('noOptions') }} value={targetType ? value?.id ?? '' : ''}
      {options} ariaLabel={label} placeholder={t(targetType === 'route' ? 'routePlaceholder' : targetType === 'service' ? 'servicePlaceholder' : 'targetTypePlaceholder')}
      {loading} disabled={loading || error || !targetType}
      onchange={id => { if (targetType) onchange({ type: targetType, id: String(id) }); }} />
  </div>
</div>
