<script lang="ts">
  import IndustrialDialog from './IndustrialDialog.svelte';
  import { Button } from '$components/ui/button';
  let open = $state(false);
</script>

<div class="space-y-3">
  <p class="text-sm text-zinc-400">复杂弹窗共享工业外壳；长内容仅正文滚动，标题与操作保持可见。含内联 Select 时保持 scrollBody=false。</p>
  <Button onclick={() => open = true}>打开工业弹窗 / Open industrial dialog</Button>
</div>
<IndustrialDialog bind:open title="工业弹窗 / Industrial dialog" description="固定标题与操作区 · 可滚动正文 / Stationary header and footer" closeLabel="关闭 / Close" scrollBody>
  {#snippet body()}
    {#each Array.from({ length: 24 }, (_, index) => index + 1) as item}
      <p class="text-sm text-zinc-300">{item}. 正文内容 / Body content — 操作始终保留在底部。</p>
    {/each}
  {/snippet}
  {#snippet footer()}<Button onclick={() => open = false}>完成 / Done</Button>{/snippet}
</IndustrialDialog>
