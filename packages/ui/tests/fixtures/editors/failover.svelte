<script lang="ts">
import FailoverEditor from '$components/domain/service/FailoverEditor.svelte';
import type { FailoverConfig } from '$types';
let failover = $state<FailoverConfig | undefined>({enabled:true,retry_on_response:['before']});
</script>
<main class="nx-page py-6"><FailoverEditor bind:failover /><output data-testid="failover-model">{JSON.stringify(failover)}</output></main>
