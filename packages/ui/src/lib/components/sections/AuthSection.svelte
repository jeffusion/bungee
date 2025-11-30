<script lang="ts">
  import type { Route } from '../../api/routes';
  import AuthEditor from '../AuthEditor.svelte';
  import { _ } from '../../i18n';

  export let route: Route;
</script>

<div class="space-y-4">
  <div>
    <h3 class="text-lg font-semibold">{$_('auth.routeAuth')}</h3>
    <p class="text-sm text-gray-500 mt-1">
      {$_('auth.routeAuthHelp')}
    </p>
  </div>

  <AuthEditor
    bind:value={route.auth}
    label={$_('auth.routeAuth')}
    showHelp={true}
    showLabel={false}
  />
</div>
