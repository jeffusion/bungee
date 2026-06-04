<!--
  PluginIcon — Renders a plugin's `metadata.icon` value as an inline SVG.

  Plugin manifests declare icons by Material-Icons ligature name (e.g.
  `transform`, `shield`, `swap_horiz`). The project never loaded the
  Material Icons font, so previously those ligature strings rendered as
  raw text. This component maps the canonical set of icons we ship to
  Lucide-style stroke SVGs that match the industrial design system.

  Behaviour:
    1. If `icon` already starts with `<svg`, it's HTML — inject as-is.
    2. Else if `icon` is a known ligature in PLUGIN_ICON_PATHS, render
       a matching stroke SVG.
    3. Else fall back to the first letter of `fallback` (or '?') as a
       monospace glyph, keeping the icon slot non-empty.
-->
<script lang="ts">
  export let icon: string | undefined | null = null;
  /** Used to derive the first-letter glyph if `icon` is unknown. */
  export let fallback: string = '?';
  /** Tailwind size classes — defaults to 5×5. */
  export let sizeClass: string = 'h-5 w-5';

  // ── Industrial icon paths (Lucide-style, 24×24 viewBox, stroke) ─────
  // Each value is one or more <path> `d` segments separated by `|`.
  // Multi-segment icons (compare_arrows, wrench) become multiple paths.
  const PLUGIN_ICON_PATHS: Record<string, string> = {
    // Bi-directional arrows ↑↓ — format transformer
    transform:
      'M16 3v4M8 21v-4M4 7l4-4 4 4M20 17l-4 4-4-4',
    // Shield outline — request sanitizer / security
    shield:
      'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
    // Horizontal swap → ↔ — protocol adapter
    swap_horiz:
      'M3 7h13M16 3l4 4-4 4M21 17H8M8 13l-4 4 4 4',
    // Double arrows comparing — diff / compare
    compare_arrows:
      'M21 8l-4-4M21 8l-4 4M21 8H3|M3 16l4-4M3 16l4 4M3 16h18',
    // Wrench — tool / signature repair
    wrench:
      'M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94z',
    // Bar chart — analytics / stats
    bar_chart:
      'M3 3v18h18|M7 16V8M11 16v-4M15 16V11',
    // Text + caret — text rotation / tool name transformer
    text_rotation_none:
      'M4 7h16M4 12h10M4 17h7|M16 14l3 3 3-3',
    // Common synonyms we may encounter in plugins
    bolt:
      'M13 2L3 14h7l-1 8 10-12h-7l1-8z',
    plug:
      'M9 2v6M15 2v6M5 8h14v3a7 7 0 11-14 0V8zM12 18v4',
    settings:
      'M12 8a4 4 0 100 8 4 4 0 000-8z|M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33h.01a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82v.01a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z',
  };

  $: trimmedIcon = (icon ?? '').trim();
  $: isInlineSvg = trimmedIcon.startsWith('<svg');
  $: paths = PLUGIN_ICON_PATHS[trimmedIcon] ?? null;
  $: pathSegments = paths ? paths.split('|') : [];
  $: glyph = (fallback || '?').charAt(0).toUpperCase();
</script>

{#if isInlineSvg}
  {@html trimmedIcon}
{:else if pathSegments.length > 0}
  <svg
    viewBox="0 0 24 24"
    class={sizeClass}
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    {#each pathSegments as d}
      <path d={d} />
    {/each}
  </svg>
{:else}
  <span class="nx-display text-lg leading-none">{glyph}</span>
{/if}
