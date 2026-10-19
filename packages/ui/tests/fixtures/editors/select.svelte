<script lang="ts">
import BSelect from '$components/industrial/BSelect.svelte';
const params = new URLSearchParams(location.search);
const mode = params.get('mode') as 'single' | 'multiple' | 'tags' || 'single';
const options = [{ value: '', label: 'All types' }, { value: 'final', label: 'Final' }];
let value = $state(params.get('value') ?? '');
let values = $state(['', 'final']);
let calls = $state<(string | string[])[]>([]);
</script>
<main class="nx-page py-6">
<BSelect options={params.has('placeholder') ? options.slice(1) : options} {mode} bind:value bind:values allowClear autoWidth={params.has('autoWidth')} ariaLabel="Selection" placeholder="Choose a type" onchange={next => calls.push(JSON.parse(JSON.stringify(next)))} />
<output data-testid="selection">{JSON.stringify({value, values, calls})}</output>
</main>
