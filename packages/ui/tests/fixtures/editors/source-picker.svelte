<script lang="ts">
import UpstreamSourcePicker from '$components/domain/route/UpstreamSourcePicker.svelte';
import type { EditorUpstream } from '$api/config-adapters';
const picker=new URLSearchParams(location.search).get('picker');
let generation=$state(0);
let upstream=$state<EditorUpstream>(picker === 'missing' ? {target:'https://chatgpt.com/backend-api/codex/responses',managedBy:{plugin:'chatgpt-oauth',contributionId:'chatgpt',bindingId:'binding'},plugins:[{_uid:'binding',name:'chatgpt-oauth',enabled:true,options:{accountRef:'missing-account'}}]} : {target:''});
</script>
<main class="nx-page py-6"><button onclick={()=>{upstream={target:'https://manual.test'};generation++;}}>Use manual upstream</button><button onclick={()=>upstream.target='https://newer-edit.test'}>Edit endpoint</button>
{#key generation}<UpstreamSourcePicker bind:upstream />{/key}<output data-testid="picker-upstream">{JSON.stringify(upstream)}</output></main>
