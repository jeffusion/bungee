<script lang="ts">
  import { onMount, afterUpdate } from 'svelte';
  import { LoadingIndicator } from '$components/industrial';

  export let pluginName: string;
  export let path: string;

  let iframe: HTMLIFrameElement;
  let loading = true;
  let sandboxAttrs = 'allow-scripts allow-same-origin'; // 默认最严格的配置

  // 动态计算插件 UI 的 URL
  // path 是相对于插件 UI 根目录的路径，例如 /dashboard
  $: src = `/__ui/plugins/${pluginName}/index.html#${path}`;

  // 计算插件的 origin，用于安全的 postMessage
  $: pluginOrigin = (() => {
    try {
      const url = new URL(src, window.location.href);
      return url.origin;
    } catch {
      // 如果 URL 解析失败，使用当前页面的 origin
      return window.location.origin;
    }
  })();

  // 获取插件的sandbox属性
  async function fetchSandboxAttrs() {
    try {
      const response = await fetch(`/__ui/api/plugins/${pluginName}/sandbox`);
      if (response.ok) {
        const data = await response.json();
        sandboxAttrs = data.sandbox || 'allow-scripts allow-same-origin';
      }
    } catch (error) {
      console.warn(`Failed to fetch sandbox attributes for ${pluginName}, using default`, error);
    }
  }

  function handleLoad() {
    loading = false;
    syncTheme();
  }

  // 同步主题到 iframe (如果插件支持)
  function syncTheme() {
    if (iframe && iframe.contentWindow) {
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      // 通过 postMessage 发送主题信息，使用具体的 origin 而不是通配符
      iframe.contentWindow.postMessage({
        type: 'bungee:theme',
        theme: isDark ? 'dark' : 'light'
      }, pluginOrigin);
    }
  }

  // 监听主题变化
  onMount(() => {
    // 获取插件的sandbox配置
    fetchSandboxAttrs();

    const observer = new MutationObserver(() => {
      syncTheme();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  });

  // 当 src 改变时重置 loading
  afterUpdate(() => {
      // 简单的检查，实际上 src 改变 iframe 会自动 reload
  });
</script>

<div class="flex-1 w-full h-[calc(100vh-64px)] relative bg-carbon-950">
  {#if loading}
    <div class="absolute inset-0 flex items-center justify-center bg-carbon-950/95 z-10">
      <LoadingIndicator label="LOADING PLUGIN UI" size="lg" height="none" />
    </div>
  {/if}

  <iframe
    bind:this={iframe}
    {src}
    title={`Plugin ${pluginName}`}
    class="w-full h-full border-none"
    on:load={handleLoad}
    sandbox={sandboxAttrs}
  ></iframe>
</div>
