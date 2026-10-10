<script lang="ts">
  import PluginEditor from '$components/domain/plugin/PluginEditor.svelte';
  import { switchLocale } from '$i18n';
  let plugins = $state([]);
</script>
<main class="nx-page py-6" data-testid="protocol-adapter-fixture">
  <button onclick={() => switchLocale('zh-CN')}>中文</button>
  <button onclick={() => switchLocale('en')}>English</button>
  <PluginEditor bind:plugins scope="route" scopeName="fixture" />
  <pre data-testid="saved-bindings">{JSON.stringify(plugins)}</pre>
</main>
