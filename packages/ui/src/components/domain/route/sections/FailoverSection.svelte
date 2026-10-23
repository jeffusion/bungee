<script lang="ts">
  import type { Route, Service } from '$api/routes';
  import FailoverEditor from '$components/domain/service/FailoverEditor.svelte';
  import { _ } from '$i18n';
  let { route = $bindable() }: {route: Route; services?: Service[]} = $props();
</script>
<FailoverEditor bind:failover={route.failover} endpointHealth={false} label={$_('routeEditor.failoverTitle')} />
