<script lang="ts">
  import type { Route } from '$api/routes';
  import AuthEditor from '$components/domain/config/AuthEditor.svelte';
  import { _ } from '$i18n';

  export let route: Route;
</script>

<div class="space-y-3">
  <p class="text-xs text-zinc-500">
    {$_('auth.routeAuthHelp')}
  </p>

  <AuthEditor
    bind:value={route.auth}
    label={$_('auth.routeAuth')}
    showHelp={true}
    showLabel={false}
  />
</div>
