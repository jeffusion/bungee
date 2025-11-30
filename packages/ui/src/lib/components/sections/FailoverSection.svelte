<script lang="ts">
  import type { Route } from '../../api/routes';
  import FailoverEditor from '../FailoverEditor.svelte';
  import { _ } from '../../i18n';

  export let route: Route;
</script>

<div class="space-y-4">
  <div>
    <h3 class="text-lg font-semibold">{$_('routeEditor.failoverTitle')}</h3>
    <p class="text-sm text-gray-500 mt-1">
      {$_('routeEditor.failoverHelp')}
    </p>
  </div>

  <FailoverEditor
    bind:value={route.failover}
    label={$_('routeEditor.failoverTitle')}
    showHelp={true}
    showLabel={false}
  />
</div>
