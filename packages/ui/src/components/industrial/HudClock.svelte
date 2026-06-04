<!--
  HudClock — Large display-style clock for the top bar.
  Mirrors the reference HUD: big orange HH:MM:SS, small date underneath.
-->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';

  /** Tone of the time text; defaults to the primary accent. */
  export let tone: 'accent' | 'zinc' = 'accent';

  /** Locale to format the date in. Defaults to user agent locale. */
  export let dateLocale: string | undefined = undefined;

  let now = new Date();
  let timer: any;

  onMount(() => {
    timer = setInterval(() => (now = new Date()), 1000);
  });

  onDestroy(() => {
    if (timer) clearInterval(timer);
  });

  function pad(n: number) {
    return String(n).padStart(2, '0');
  }

  $: timeText = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  $: dateText = now
    .toLocaleDateString(dateLocale ?? undefined, {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    })
    .toUpperCase();

  $: timeClass = tone === 'accent' ? 'text-nexus-500' : 'text-zinc-100';
</script>

<div class="flex flex-col items-end leading-none">
  <span class="nx-display text-xl tabular-nums {timeClass}">{timeText}</span>
  <span class="mt-1 font-mono text-[10px] uppercase tracking-chiseled text-zinc-500">{dateText}</span>
</div>
