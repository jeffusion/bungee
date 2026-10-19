<script lang="ts">
import UpstreamsSection from '$components/domain/route/sections/UpstreamsSection.svelte';
let route = $state({ endpoints: [
{ _uid:'hidden',target:'https://hidden.test',description:'private',priority:1,weight:100 },
{ _uid:'visible',target:'https://ALPHA.test',description:'Primary Pool',priority:5,weight:20 },
{ _uid:'other',target:'https://other.test',description:'Backup Pool',priority:9,weight:30 },
] });
</script>
<main class="nx-page py-6"><UpstreamsSection bind:route isService /><output data-testid="endpoints">{JSON.stringify(route.endpoints)}</output></main>
