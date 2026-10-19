<script lang="ts">
import PluginEditor from '$components/domain/plugin/PluginEditor.svelte';
import type { EditorPluginBinding } from '$api/config-adapters';
const params = new URLSearchParams(location.search);
let plugins = $state<EditorPluginBinding[]>([{ _uid:'owner', _position:4, name:'fixture-plugin', enabled:false, options:{accountRef:'account',unknown:{nested:[1,2]},visible:'before'} }]);
</script>
<main class="nx-page py-6"><PluginEditor bind:plugins protectedBindingIds={params.has('protected') ? ['owner'] : []} /><output data-testid="plugins">{JSON.stringify(plugins)}</output></main>
