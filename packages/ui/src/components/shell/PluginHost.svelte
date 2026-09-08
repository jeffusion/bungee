<script lang="ts">
  import { onMount } from 'svelte';
  import { push } from 'svelte-spa-router';
  import { LoadingIndicator } from '$components/industrial';
  import { PluginsAPI, type Plugin } from '$api/plugins';
  import { api, requestPluginControl } from '$api/client';
  import { getConfigSnapshot } from '$api/config';
  import { accountReferences } from '$api/upstream-sources';
  import { allowedControlRequest, safeExternalUrl } from '$pluginSdk/host-messages';

  let { pluginName, path, height = 'calc(100vh - 64px)' }: { pluginName: string; path: string; height?: string } = $props();

  let iframe = $state<HTMLIFrameElement>();
  let loading = $state(true);
  let externalUrl = $state<string | null>(null);
  let plugin: Plugin | undefined;
  const lifetime = new AbortController();

  async function handleMessage(event: MessageEvent) {
    if (event.source !== iframe?.contentWindow || event.origin !== pluginOrigin
      || event.data?.type !== 'bungee:host-request' || typeof event.data.id !== 'string' || event.data.id.length > 128) return;
    const frame = iframe.contentWindow;
    const owner = pluginName;
    const message = event.data;
    try {
      let result: unknown;
      if (message.action === 'ui-context') {
        result = { css: Array.from(document.styleSheets).map(sheet => {
          try { return Array.from(sheet.cssRules).map(rule => rule.cssText).join('\n'); } catch { return ''; }
        }).join('\n') };
      } else if (message.action === 'open-external') {
        const url = safeExternalUrl(message.url);
        if (!url) throw new Error('仅支持不含用户名或密码的 HTTPS 链接');
        externalUrl = url;
        result = { confirmationRequired: true };
      } else if (message.action === 'new-service') {
        await push('/services/new'); result = { opened: true };
      } else if (message.action === 'references') {
        if (typeof message.accountRef !== 'string' || !message.accountRef || message.accountRef.length > 128) throw new Error('账号引用无效');
        const snapshot = await getConfigSnapshot();
        result = { ...accountReferences(snapshot.config.logical_configuration, owner, message.accountRef), revision: snapshot.revision };
      } else if (message.action === 'control') {
        if (plugin?.name !== owner) plugin = (await PluginsAPI.list()).find(item => item.name === owner);
        if (!plugin || !allowedControlRequest(plugin, message.path, message.method)) throw new Error('插件未声明此控制接口');
        if (JSON.stringify(message.body ?? {}).length > 65536) throw new Error('请求内容过长');
        result = await requestPluginControl(owner, message.path, message.method, message.body, lifetime.signal);
      } else throw new Error('不支持的宿主操作');
      if (!lifetime.signal.aborted && owner === pluginName && frame === iframe?.contentWindow) frame?.postMessage({ type: 'bungee:host-result', id: message.id, result }, pluginOrigin);
    } catch (error) {
      if (!lifetime.signal.aborted && owner === pluginName && frame === iframe?.contentWindow) frame?.postMessage({ type: 'bungee:host-result', id: message.id, error: error instanceof Error ? error.message : '操作失败' }, pluginOrigin);
    }
  }
  let sandboxAttrs = $state('allow-scripts allow-same-origin'); // 默认最严格的配置

  // 动态计算插件 UI 的 URL
  // path 是相对于插件 UI 根目录的路径，例如 /dashboard
  let src = $derived(`/__ui/plugins/${pluginName}/index.html#${path}`);

  // 计算插件的 origin，用于安全的 postMessage
  let pluginOrigin = $derived.by(() => {
    try {
      const url = new URL(src, window.location.href);
      return url.origin;
    } catch {
      // 如果 URL 解析失败，使用当前页面的 origin
      return window.location.origin;
    }
  });

  // 获取插件的sandbox属性
  async function fetchSandboxAttrs() {
    try {
      const data = await api.get<{ sandbox: string }>(`/plugins/${encodeURIComponent(pluginName)}/sandbox`);
      sandboxAttrs = data.sandbox || 'allow-scripts allow-same-origin';
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
      const theme = document.documentElement.getAttribute('data-theme');
      const isDark = theme === 'dark' || theme === 'industrial';
      // 通过 postMessage 发送主题信息，使用具体的 origin 而不是通配符
      iframe.contentWindow.postMessage({
        type: 'bungee:theme',
        theme: isDark ? 'dark' : 'light'
      }, pluginOrigin);
    }
  }

  // 监听主题变化
  onMount(() => {
    window.addEventListener('message', handleMessage);
    // 获取插件的sandbox配置
    fetchSandboxAttrs();

    const observer = new MutationObserver(() => {
      syncTheme();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      observer.disconnect(); lifetime.abort(); window.removeEventListener('message', handleMessage);
    };
  });
</script>

<div class="flex-1 w-full min-h-[320px] relative bg-carbon-950" style:height>
  {#if externalUrl}
    <div role="region" aria-label="打开外部页面" class="absolute top-0 inset-x-0 z-20 border border-nexus-500 bg-carbon-900 p-4 shadow-industrial">
      <p class="text-sm text-zinc-200">插件请求打开外部页面，请核对地址后继续。</p>
      <p class="my-2 font-mono text-xs text-nexus-300 break-all">{new URL(externalUrl).origin}{new URL(externalUrl).pathname}</p>
      <div class="flex gap-2">
        <a class="nx-btn-primary" href={externalUrl} target="_blank" rel="noopener noreferrer" onclick={() => externalUrl = null}>打开验证页面</a>
        <button class="nx-btn-ghost" onclick={() => externalUrl = null}>取消</button>
      </div>
    </div>
  {/if}
  {#if loading}
    <div class="absolute inset-0 flex items-center justify-center bg-carbon-950/95 z-10">
      <LoadingIndicator label="正在加载插件页面" size="lg" height="none" />
    </div>
  {/if}

  <iframe
    bind:this={iframe}
    {src}
    title={`Plugin ${pluginName}`}
    class="w-full h-full border-none"
    onload={handleLoad}
    sandbox={sandboxAttrs}
  ></iframe>
</div>
