<script lang="ts">
  import { Globe } from 'lucide-svelte';
  import github from './assets/github.svg';
  import google from './assets/google.svg';
  import microsoft from './assets/microsoft.svg';
  import type { LoginProvider } from './contracts';

  let {provider}: {provider: LoginProvider} = $props();
  const marks = {github, google, microsoft};
</script>

<!-- Brand marks: Simple Icons 11.15.0, CC0; see assets/LICENSE.txt. -->
<span class="flex h-10 w-10 shrink-0 items-center justify-center text-zinc-100" aria-hidden="true">
  {#if provider === 'oidc'}
    <Globe size={28} strokeWidth={1.5} />
  {:else}
    <img src={marks[provider]} alt="" class="h-7 w-7 brightness-0 invert" />
  {/if}
</span>
