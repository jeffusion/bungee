<script lang="ts">
  import { onMount } from 'svelte';
  import { loadTurnstile, type TurnstileApi } from './turnstile';
  import { Button } from '$components/ui/button';
  let { siteKey, resetKey = 0, onToken, retryLabel, failureLabel }: { siteKey: string; resetKey?: number; onToken(token: string): void; retryLabel: string; failureLabel: string } = $props();
  let container: HTMLDivElement, api: TurnstileApi | undefined, widget: string | undefined;
  let failed = $state(false), mounted = false, active = true;
  async function render() {
    failed = false; onToken('');
    try {
      const loaded = await loadTurnstile();
      if (!active) return;
      api = loaded;
      widget = loaded.render(container, { sitekey: siteKey, action: 'local-login', size: 'flexible',
        callback: token => { if (active) onToken(token); },
        'expired-callback': () => { if (active) { onToken(''); if (widget !== undefined) loaded.reset(widget); } },
        'error-callback': () => { if (active) { onToken(''); failed = true; if (widget !== undefined) loaded.reset(widget); } },
      });
    } catch { if (active) failed = true; }
  }
  function retry() { if (widget !== undefined) { api?.remove(widget); widget = undefined; } void render(); }
  $effect(() => { void resetKey; if (mounted && widget !== undefined) { onToken(''); api?.reset(widget); } });
  onMount(() => { mounted = true; void render(); return () => { active = false; if (widget !== undefined) api?.remove(widget); onToken(''); }; });
</script>
<div class="min-w-0" data-testid="turnstile-challenge"><div bind:this={container}></div></div>
{#if failed}<p role="alert" class="text-sm text-red-400">{failureLabel}</p><Button variant="ghost" type="button" onclick={retry}>{retryLabel}</Button>{/if}
