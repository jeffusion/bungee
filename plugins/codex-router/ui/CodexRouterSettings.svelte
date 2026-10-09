<script lang="ts">
  import { _, isLoading } from '$i18n';
  import { getPluginText } from '$utils/plugin-i18n';
  import { PanelCard } from '$components/industrial';
  import CodexModelsEditor from '$components/domain/codex-router/CodexModelsEditor.svelte';

  const t = (key: string) => $isLoading ? '' : getPluginText(`settings.${key}`, 'codex-router', (id, options) => $_(id, options));
</script>

<div class="space-y-4" data-testid="codex-router-settings">
  <PanelCard title={t('bindings')}>
    <p class="text-sm text-zinc-400">{t('description')}</p>
    <div class="mt-4 flex flex-wrap gap-3">
      <a class="nx-btn-primary" href="#/routes">{t('routes')}</a>
      <a class="nx-btn-secondary" href="#/plugins/models-dev/catalog/status">{t('modelsDev')}</a>
    </div>
  </PanelCard>
  <PanelCard title={t('catalog')}>
    <CodexModelsEditor catalogOnly />
  </PanelCard>
</div>
