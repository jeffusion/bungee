<!--
  CornerBrackets — renders 4 L-shaped corner indicators on the corners of
  a positioned parent. The parent MUST have `position: relative` (or its
  own positioning context); typically you spread `.nx-bracketed` on the
  parent so hover/focus styles in app.css can react.

  Used internally by PanelCard and KpiCard. Exposed for ad-hoc use too.
-->
<script lang="ts">
  /** Hide individual corners by passing false. Defaults: all four shown. */
  export let tl: boolean = true;
  export let tr: boolean = true;
  export let bl: boolean = true;
  export let br: boolean = true;
</script>

{#if tl}<span class="nx-corner nx-corner-tl" aria-hidden="true"></span>{/if}
{#if tr}<span class="nx-corner nx-corner-tr" aria-hidden="true"></span>{/if}
{#if bl}<span class="nx-corner nx-corner-bl" aria-hidden="true"></span>{/if}
{#if br}<span class="nx-corner nx-corner-br" aria-hidden="true"></span>{/if}
