<script lang="ts">
import { Button } from '$components/ui/button';
import UpstreamsSection from '$components/domain/route/sections/UpstreamsSection.svelte';
import UpstreamForm from '$components/domain/route/UpstreamForm.svelte';
let section: { openUpstreamModal(index?: number): void } | undefined = $state();
let route=$state({endpoints:[{_uid:'endpoint',target:'https://chatgpt.com/backend-api/codex/responses',weight:100,priority:1,
managedBy:{plugin:'chatgpt-oauth',contributionId:'chatgpt',bindingId:'binding'},
plugins:[{_uid:'binding',name:'chatgpt-oauth',enabled:true,options:{accountRef:'account-1'}}]}]});
const params=new URLSearchParams(location.search);
</script>
<main class="nx-page py-6">
{#if params.get('endpoint') === 'modal'}
<Button onclick={()=>section?.openUpstreamModal(0)}>Open endpoint</Button>
<UpstreamsSection bind:this={section} bind:route isService />
{:else if params.get('endpoint') === 'inline'}
<UpstreamForm bind:upstream={route.endpoints[0]} index={0} onRemove={()=>{}} onDuplicate={()=>{}} />
{/if}
</main>
