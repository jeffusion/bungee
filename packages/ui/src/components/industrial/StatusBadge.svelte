<!--
  StatusBadge — Outlined pill for state communication.
-->
<script lang="ts">
  export let variant:
    | 'active'    // healthy / online (emerald)
    | 'standby'   // caution / standby (amber)
    | 'online'    // primary accent (orange)
    | 'fault'     // error / failed (red)
    | 'muted'     // idle / disabled (zinc)
    | 'info'      // informational (sky)
    = 'muted';

  /** When true, show a leading status dot of a matching color. */
  export let dot: boolean = false;

  let extraClass = '';
  export { extraClass as class };

  const cls = {
    active: 'nx-badge-active',
    standby: 'nx-badge-standby',
    online: 'nx-badge-online',
    fault: 'nx-badge-fault',
    muted: 'nx-badge-muted',
    info: 'nx-badge-info',
  } as const;

  const dotStatus = {
    active: 'ok',
    standby: 'warn',
    online: 'accent',
    fault: 'danger',
    muted: 'idle',
    info: 'accent',
  } as const;

  // dot uses StatusDot via class to avoid extra import overhead
  const dotCls = {
    ok: 'nx-dot-ok',
    warn: 'nx-dot-warn',
    accent: 'nx-dot-accent',
    danger: 'nx-dot-danger',
    idle: 'nx-dot-idle',
  } as const;
</script>

<span class="{cls[variant]} {extraClass}">
  {#if dot}
    <span class={dotCls[dotStatus[variant]]}></span>
  {/if}
  <slot />
</span>
