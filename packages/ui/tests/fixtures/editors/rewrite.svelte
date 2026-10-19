<script lang="ts">
import BasicInfoSection from '$components/domain/route/sections/BasicInfoSection.svelte';
import type { Route } from '$types';
let route = $state<Route>({path:'/before',plugins:[],path_rewrite:{'^/before':'/after'}});
</script>
<main class="nx-page py-6"><BasicInfoSection bind:route showOnly="path" /><BasicInfoSection bind:route showOnly="rewrite" /><output data-testid="rewrite-model">{JSON.stringify(route)}</output></main>
