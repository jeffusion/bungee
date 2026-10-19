<script lang="ts">
  import PluginEditor from '$components/domain/plugin/PluginEditor.svelte';
  import type { EditorPluginBinding } from '$api/config-adapters';
  let plugins = $state<Array<EditorPluginBinding | string>>(JSON.parse(new URLSearchParams(location.search).get('plugins') ?? '[]'));
</script>
<main class="nx-page py-6" data-testid="router-fixture">
  <PluginEditor bind:plugins scope="route" scopeName="fixture" />
  <pre data-testid="saved-bindings">{JSON.stringify(plugins)}</pre>
</main>
