<script lang="ts">
import RouteEditor from '$lib/routes/RouteEditor.svelte';
const params=new URLSearchParams(location.search);
</script>
<main class="nx-page py-6"><RouteEditor params={params.has('edit') ? {path:'%2Floaded'} : {}} /></main>
