<script lang="ts">
  import type { Route } from '$api/routes';
  import DirectionalModificationEditor from '../DirectionalModificationEditor.svelte';
  export let route: Route;
</script>
<DirectionalModificationEditor bind:policy={route} />
