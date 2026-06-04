<!--
  FeatureBadge — Compact chip marking a route's *capability* (auth / cors /
  rateLimit / retry / directResponse / plugins / modification).

  Visual: industrial — mono uppercase, single zinc → orange palette
  (clickable hover lights up in nexus orange). The previous version used
  7 unique brand colours which conflicts with the industrial system's
  single-accent rule.

  API preserved:
    badge: RouteFeatureBadgeDescriptor (required)
    className: extra classes appended to the chip
    on:click → emitted with { id, section } for parents that deep-link
-->
<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { _ } from '$i18n';
  import type { RouteFeatureBadgeDescriptor } from '$utils/route-service-view-model';

  const dispatch = createEventDispatcher<{
    click: { id: string; section: string };
  }>();

  export let badge: RouteFeatureBadgeDescriptor;
  export let className = '';

  function handleClick() {
    dispatch('click', { id: badge.id, section: badge.section });
  }

  function handleKey(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleClick();
    }
  }
</script>

<button
  type="button"
  class="nx-feature-tag-interactive {className}"
  title={badge.label}
  data-testid={`feature-badge-${badge.id}`}
  on:click={handleClick}
  on:keydown={handleKey}
>
  {(badge.labelKey ? $_(badge.labelKey) : badge.label).toUpperCase()}
</button>
