<!--
  StatusDot — A tiny luminous indicator. Variants map to canonical statuses.
-->
<script lang="ts">
  export let status: 'ok' | 'warn' | 'danger' | 'idle' | 'accent' = 'idle';
  let extraClass = '';
  export { extraClass as class };

  const cls = {
    ok: 'nx-dot-ok',
    warn: 'nx-dot-warn',
    danger: 'nx-dot-danger',
    idle: 'nx-dot-idle',
    accent: 'nx-dot-accent',
  } as const;
</script>

<span class="{cls[status]} {extraClass}" aria-hidden="true"></span>
