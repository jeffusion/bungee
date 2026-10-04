<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { BCarousel, PanelCard } from '$components/industrial';
  let items = $state(['Alpha', 'Bravo', 'Charlie']);
  let index = $state(0);
  let autoplay = $state(true);
  let loop = $state(true);
  let interval = $state(1000);
  let mounted = $state(true);
  let changes = $state<number[]>([]);
  onMount(() => {
    Object.assign(window, {
      carouselTest: {
        configure: async (next: { items?: string[]; index?: number; autoplay?: boolean; loop?: boolean; interval?: number; mounted?: boolean }) => {
          if (next.items !== undefined) items = next.items;
          if (next.index !== undefined) index = next.index;
          if (next.autoplay !== undefined) autoplay = next.autoplay;
          if (next.loop !== undefined) loop = next.loop;
          if (next.interval !== undefined) interval = next.interval;
          if (next.mounted !== undefined) mounted = next.mounted;
          await tick();
        },
        settle: tick,
        state: () => ({ index, changes: [...changes] }),
      },
    });
  });
</script>

<main class="nx-page py-6 space-y-6">
  <button type="button" class="nx-btn-ghost" id="outside">Outside carousel</button>
  <PanelCard title="轮播 / Carousel" tag="TEST">
    {#if mounted}
      <BCarousel {items} bind:index {autoplay} {interval} {loop} onchange={value => changes.push(value)} ariaLabel="Test carousel">
        {#snippet children(item)}
          <h2 class="nx-display text-xl text-zinc-50">{item}</h2>
          <p class="my-3 text-sm text-zinc-300">工业轮播内容 / Industrial carousel content</p>
          <input aria-label={`${item} input`} class="nx-input" value={item} />
          <div>
            <label for={`${item}-toggle`}>{item} toggle</label>
            <input type="checkbox" id={`${item}-toggle`} />
            <details><summary>{item} details</summary><p>Native expanded content</p></details>
          </div>
        {/snippet}
      </BCarousel>
    {/if}
  </PanelCard>
</main>
