<script lang="ts">
import type { Route } from '$api/routes';
import UpstreamsSection from '$components/domain/route/sections/UpstreamsSection.svelte';
const mixed = new URLSearchParams(location.search).has('mixed');
let route = $state<Pick<Route, 'endpoints' | 'service_references'>>({
service_references: mixed ? [{id:'child-reference',position:3,service_id:'child',weight:100,priority:5,is_disabled:false}] : undefined, endpoints: [
{ _uid:'hidden',_position:0,target:'https://hidden.test',description:'private',priority:1,weight:100 },
{ _uid:'visible',_position:1,target:'https://ALPHA.test',description:'Primary Pool',priority:5,weight:20 },
{ _uid:'other',_position:2,target:'https://other.test',description:'Backup Pool',priority:9,weight:30 },
] });
</script>
<main class="nx-page py-6"><UpstreamsSection bind:route isService services={[{_uid:'child',name:'child-service',endpoints:[]}]} /><output data-testid="endpoints">{JSON.stringify(route.endpoints)}</output><output data-testid="service-references">{JSON.stringify(route.service_references)}</output></main>
