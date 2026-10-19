<script lang="ts">
  import { _, isLoading } from 'svelte-i18n';
  import LoginSettings from './LoginSettings.svelte';
  import SessionPolicy from './SessionPolicy.svelte';
  let { pluginName = 'user-auth' }: { pluginName?: string; apiBase?: string } = $props();
  const t = (key: string) => $isLoading ? '' : $_(`plugins.user-auth.${key}`);
</script>
<div class="border-b border-carbon-600" data-testid="auth-login-management">
  <div class="space-y-2">
    <h1 class="nx-display text-xl text-zinc-50">{t('settings.title')}</h1>
  </div>
  <LoginSettings {pluginName} />
  <SessionPolicy {pluginName} />
</div>
