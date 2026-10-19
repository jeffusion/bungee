<script lang="ts">
import { Button } from '$components/ui/button';
import * as Dialog from '$components/ui/dialog';
import { IndustrialDialog } from '$components/industrial';
import * as Select from '$components/ui/select';
import DesignSystem from '$lib/routes/DesignSystem.svelte';
const params = new URLSearchParams(location.search);
const kind = params.get('dialog');
let open = $state(false);
let selected=$state<{value:string;label:string}>({value:'new',label:'New service'});
const options=[{value:'new',label:'New service'},{value:'existing',label:'existing-service'},...Array.from({length:11},(_,index)=>({value:`service-${index}`,label:`Service ${String(index+1).padStart(2,'0')}`}))];
</script>
<main class="nx-page py-6">
{#if params.has('select')}
<Button onclick={()=>open=true}>Open selection</Button>
<IndustrialDialog bind:open title="Choose service" description="Selection in a dialog">
{#snippet body()}
<Select.Root bind:selected><Select.Trigger aria-label="Choose service" class="w-full"><Select.Value /></Select.Trigger><Select.Content>{#each options as option}<Select.Item value={option.value} label={option.label}>{option.label}</Select.Item>{/each}</Select.Content></Select.Root>
{/snippet}
{#snippet footer()}<Button onclick={()=>open=false}>Done</Button>{/snippet}
</IndustrialDialog>
{:else if params.has('design')}
<DesignSystem />
{:else if kind === 'industrial'}
<Button onclick={() => open = true}>Open focus fixture</Button>
<IndustrialDialog bind:open title="Close focus fixture" description="Industrial dialog keyboard and pointer focus">
{#snippet body()}<p>Local fixture. No account operations.</p>{/snippet}
</IndustrialDialog>
{:else if kind === 'standard'}
<Dialog.Root>
<Dialog.Trigger asChild let:builder><Button builders={[builder]}>Open focus fixture</Button></Dialog.Trigger>
<Dialog.Content><Dialog.Title>Close focus fixture</Dialog.Title><Dialog.Description>Standard dialog keyboard and pointer focus</Dialog.Description></Dialog.Content>
</Dialog.Root>
{/if}
</main>
