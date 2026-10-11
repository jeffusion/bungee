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
  let options = $derived.by(() => {
    const result = targets.map(target => ({ value: JSON.stringify([target.type, target.id]), label: `${t(target.type)} · ${target.label}`, disabled: false }));
    if (value?.id && !result.some(option => option.value === JSON.stringify([value.type, value.id]))) {
      result.push({ value: JSON.stringify([value.type, value.id]), label: `${t(value.type)} · ${value.id}${loading ? '' : ` · ${t('targetUnavailable')}`}`, disabled: true });
    }
    return result;
  });
</script>

<div class="min-w-0 space-y-2">
  <Label class="block" for={id}>{label}</Label>
  <BSelect {id} searchable searchLabels={{ empty: t('noOptions') }} value={value?.id ? JSON.stringify([value.type, value.id]) : ''}
    {options} ariaLabel={label} placeholder={t('targetPlaceholder')} loading={loading} disabled={loading || error}
    onchange={encoded => { const [type, id] = JSON.parse(String(encoded)); onchange({ type, id }); }} />
</div>
