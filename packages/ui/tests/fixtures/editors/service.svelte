<script lang="ts">
import ServiceEditor from '$lib/routes/ServiceEditor.svelte';
const params=new URLSearchParams(location.search);
</script>
<main class="nx-page py-6"><ServiceEditor params={params.has('edit') ? {name:'existing'} : {}} /></main>
