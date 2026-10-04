<script lang="ts">
  import { BCarousel } from '$components/industrial';

  const items = [
    { code: '01', title: '统一入口 / Unified access', description: '将服务汇聚到一个入口，按需查看每一项能力。Bring services together and explore one capability at a time.' },
    { code: '02', title: '灵活路由 / Flexible routing', description: '为不同请求选择合适的上游，让流量按规则流转。Choose the right upstream for each request.' },
    { code: '03', title: '运行洞察 / Operational insight', description: '查看关键指标与请求记录，了解当前运行状态。Inspect metrics and request history in one place.' },
  ];
  const labels = {
    previous: '上一项 / Previous slide', next: '下一项 / Next slide',
    pause: '暂停轮播 / Pause autoplay', play: '开始轮播 / Start autoplay',
    empty: '暂无内容 / No slides', slide: '幻灯片 / slide',
    reducedMotion: '已按减少动态效果偏好关闭自动轮播 / Reduced motion',
    goTo: (position: number) => `切换到第 ${position} 项 / Go to slide ${position}`,
    position: (position: number, total: number) => `第 ${position} 项，共 ${total} 项 / Slide ${position} of ${total}`,
  };
</script>

<div class="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-2" data-testid="design-carousel">
  <div class="min-w-0 space-y-3">
    <p class="nx-field-label">自动轮播 / Autoplay</p>
    <BCarousel {items} {labels} ariaLabel="自动轮播示例 / Autoplay example">
      {#snippet children(item)}
        <div class="space-y-3">
          <span class="nx-display text-3xl text-zinc-50">{item.code}</span>
          <h3 class="font-mono text-base font-semibold text-zinc-100">{item.title}</h3>
          <p class="text-sm leading-relaxed text-zinc-300">{item.description}</p>
        </div>
      {/snippet}
    </BCarousel>
    <p class="text-sm text-zinc-400">每 5 秒切换；悬停或聚焦时暂停，也可主动暂停。减少动态效果模式下仅手动切换。</p>
  </div>
  <div class="min-w-0 space-y-3">
    <p class="nx-field-label">手动切换 / Manual navigation</p>
    <BCarousel {items} {labels} autoplay={false} loop={false} ariaLabel="手动轮播示例 / Manual example">
      {#snippet children(item)}
        <div class="space-y-3">
          <span class="nx-display text-3xl text-zinc-50">{item.code}</span>
          <h3 class="font-mono text-base font-semibold text-zinc-100">{item.title}</h3>
          <p class="text-sm leading-relaxed text-zinc-300">{item.description}</p>
        </div>
      {/snippet}
    </BCarousel>
    <p class="text-sm text-zinc-400">使用箭头或页码切换；聚焦内容区后可按 ← / →、Home / End。首尾不循环。</p>
  </div>
</div>
