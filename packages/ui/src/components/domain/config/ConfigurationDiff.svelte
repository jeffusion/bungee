<script lang="ts">
  import type { ConfigDiff } from './workspace';
  import { _ } from '$i18n';
  import { isLoading } from 'svelte-i18n';
  let { changes, testId = 'config-diff' }: { changes: ConfigDiff[]; testId?: string } = $props();
  const t = (key: string) => $isLoading ? '' : $_(`settings.diff.${key}`);
  const value = (v: string) => /^(defaultSeconds|seconds):\d+$/.test(v)
    ? $_(`settings.publication.${v.startsWith('defaultSeconds:') ? 'defaultSeconds' : 'seconds'}`, { values: { value: Number(v.split(':')[1]) } })
    : ['hidden', 'unset', 'on', 'off'].includes(v) ? t(v) : v;
  const label = (key: ConfigDiff['label']) => key.endsWith('_timeout_ms') ? $_(`settings.publication.${key}.label`)
    : key === 'publicationHidden' ? $_('settings.publication.otherSettings') : t(key);
</script>
<ul class="divide-y divide-carbon-600 border border-carbon-600" data-testid={testId}>
  {#each changes as change}<li class="space-y-1 p-3">
    <p class="break-words text-sm font-semibold text-zinc-200">{label(change.label)} · {t(change.action)}</p>
    {#if change.count !== undefined}
      <p class="break-all text-sm text-zinc-300">{change.action === 'reordered' ? `${change.count} ${t('items')}` : change.identity ?? t('unidentified')}</p>
      <p class="text-sm text-zinc-400">{t('hiddenDetails')}</p>
      {#if change.bindings}<p class="text-sm text-zinc-400">{t('bindingCount')}: {change.bindings[0] ?? '—'} → {change.bindings[1] ?? '—'}</p>{/if}
      {#if change.endpoints}<p class="text-sm text-zinc-400">{t('endpointCount')}: {change.endpoints[0] ?? '—'} → {change.endpoints[1] ?? '—'}</p>{/if}
    {:else}
      <p class="break-words text-sm text-zinc-400">{value(change.before)} → <span class="text-zinc-100">{value(change.after)}</span></p>
    {/if}
  </li>{/each}
</ul>
