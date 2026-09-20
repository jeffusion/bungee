<script lang="ts">
  import { onMount } from 'svelte';
  import { push } from 'svelte-spa-router';
  import { LoadingIndicator } from '$components/industrial';
  import { api, requestPluginControl } from '$api/client';
  import { getConfigSnapshot } from '$api/config';
  import { accountReferences } from '$api/upstream-sources';
  import { allowedHostAction, isCanonicalControlPath, safeExternalUrl, validateHostRequest, MAX_SEEN_HOST_REQUEST_IDS, type PluginHostPolicy, type PluginHostRequest } from '$pluginSdk/host-messages';

  let { pluginName, path, height = 'calc(100vh - 64px)' }: { pluginName: string; path: string; height?: string } = $props();

  let iframe = $state<HTMLIFrameElement>();
  let loading = $state(true);
  let externalUrl = $state<string | null>(null);
  let sandboxFailure = $state<string | null>(null);
  let lifetime = new AbortController();
  type Bridge = { generation: number; nonce: string; port: MessagePort; seenIds: Set<string>; policy: PluginHostPolicy };
  let bridge: Bridge | undefined;
  let generation = 0;
  let policy: PluginHostPolicy | undefined;
  let armedSrc = '';
  let sourceGeneration = 0;
  let hostLoadArmed = false;
  let policyRequest: Promise<void> = Promise.resolve();

  function newNonce(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function closeBridge() {
    const hadBridge = bridge !== undefined;
    bridge?.port.close();
    bridge = undefined;
    lifetime.abort();
    lifetime = new AbortController();
    if (hadBridge) generation += 1;
  }

  function sendResult(current: Bridge, id: string, result?: unknown, error?: string) {
    if (bridge !== current || current.generation !== generation) return;
    try { current.port.postMessage({ type: 'bungee:host-result', generation: current.generation, nonce: current.nonce, id, result, error }); } catch { /* port was closed during teardown */ }
  }

  async function handlePortMessage(current: Bridge, value: unknown) {
    if (bridge !== current || current.generation !== generation) return;
    if (current.seenIds.size >= MAX_SEEN_HOST_REQUEST_IDS) {
      closeBridge();
      return;
    }
    const checked = validateHostRequest(value, current.generation, current.nonce, current.seenIds);
    if ('error' in checked) {
      if (checked.id) sendResult(current, checked.id, undefined, checked.error);
      return;
    }
    const message: PluginHostRequest = checked.request;
    const owner = pluginName;
    try {
      if (!allowedHostAction(current.policy, message.action, message.path, message.method)) {
        throw new Error('插件策略不允许此宿主操作');
      }
      let result: unknown;
      if (message.action === 'ui-context' || message.action === 'copy-styles') {
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
        const accountRef = message.accountRef;
        if (typeof accountRef !== 'string' || !accountRef || accountRef.length > 128) throw new Error('账号引用无效');
        const snapshot = await getConfigSnapshot();
        result = { ...accountReferences(snapshot.config.logical_configuration, owner, accountRef), revision: snapshot.revision };
      } else if (message.action === 'control') {
        result = await requestPluginControl(owner, message.path as string, message.method as 'GET' | 'POST' | 'PUT' | 'DELETE', message.body, lifetime.signal);
      }
      sendResult(current, message.id, result);
    } catch (error) {
      sendResult(current, message.id, undefined, error instanceof Error ? error.message : '操作失败');
    }
  }

  let sandboxAttrs = $state('allow-scripts');

  // 动态计算插件 UI 的 URL
  // path 是相对于插件 UI 根目录的路径，例如 /dashboard
  let src = $derived(`/plugins/${pluginName}/index.html#${path}`);

  type SandboxResponse = Readonly<{
    sandbox?: unknown;
    allowedHostActions?: readonly unknown[];
    controlAllowlist?: readonly unknown[];
  }>;

  async function fetchSandboxPolicy(nextSrc: string, token: number) {
    try {
      const data = await api.get<SandboxResponse>(`/plugins/${encodeURIComponent(pluginName)}/sandbox`);
      if (nextSrc !== src || token !== sourceGeneration) return;
      if (data.sandbox !== 'allow-scripts' || !Array.isArray(data.allowedHostActions) || !Array.isArray(data.controlAllowlist)) {
        policy = undefined;
        return;
      }
      sandboxAttrs = data.sandbox;
      const allowedHostActions = data.allowedHostActions.filter((value): value is PluginHostPolicy['allowedHostActions'][number] =>
        typeof value === 'string' && ['ui-context', 'copy-styles', 'open-external', 'new-service', 'references', 'control'].includes(value));
      const controlAllowlist = data.controlAllowlist.map(value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const entry = value as { path?: unknown; methods?: unknown };
        if (!isCanonicalControlPath(entry.path)
          || !Array.isArray(entry.methods) || entry.methods.some(method => typeof method !== 'string'
            || !['GET', 'POST', 'PUT', 'DELETE'].includes(method))) return null;
        return Object.freeze({ path: entry.path, methods: Object.freeze([...entry.methods] as ('GET' | 'POST' | 'PUT' | 'DELETE')[]) });
      });
      const controlEntries = controlAllowlist.filter((value): value is NonNullable<(typeof controlAllowlist)[number]> => value !== null);
      const controlKeys = controlEntries.flatMap(entry => entry.methods.map(method => `${entry.path}\u0000${method}`));
      if (allowedHostActions.length !== data.allowedHostActions.length
        || new Set(allowedHostActions).size !== allowedHostActions.length
        || controlEntries.length !== data.controlAllowlist.length
        || new Set(controlKeys).size !== controlKeys.length) {
        policy = undefined;
        return;
      }
      policy = Object.freeze({
        sandbox: 'allow-scripts',
        allowedHostActions: Object.freeze(allowedHostActions),
        controlAllowlist: Object.freeze(controlEntries),
      });
    } catch (error) {
      policy = undefined;
      console.warn(`Failed to fetch sandbox policy for ${pluginName}`, error);
    }
  }

  function navigationFailure() {
    closeBridge();
    sourceGeneration += 1;
    hostLoadArmed = false;
    sandboxFailure = 'Sandbox navigation blocked';
    loading = true;
    console.warn(`Sandbox navigation blocked for ${pluginName}`);
  }

  function armSource(nextSrc: string) {
    if (nextSrc === armedSrc) return;
    armedSrc = nextSrc;
    sourceGeneration += 1;
    hostLoadArmed = true;
    sandboxFailure = null;
    loading = true;
    closeBridge();
    policy = undefined;
    policyRequest = fetchSandboxPolicy(nextSrc, sourceGeneration);
  }

  $effect(() => armSource(src));

  function handleLoad() {
    if (!hostLoadArmed || !iframe?.contentWindow) return navigationFailure();
    hostLoadArmed = false;
    const token = sourceGeneration;
    const frame = iframe.contentWindow;
    void policyRequest.then(() => {
      if (token !== sourceGeneration || frame !== iframe?.contentWindow) return;
      const currentPolicy = policy;
      if (currentPolicy === undefined) return navigationFailure();
      generation += 1;
      const channel = new MessageChannel();
      const current: Bridge = { generation, nonce: newNonce(), port: channel.port1, seenIds: new Set(), policy: currentPolicy };
      bridge = current;
      current.port.onmessage = event => { void handlePortMessage(current, event.data); };
      current.port.start();
      frame.postMessage({ type: 'bungee:bridge-init', generation: current.generation, nonce: current.nonce }, '*', [channel.port2]);
      loading = false;
      syncTheme();
    });
  }

  // 同步主题到 iframe (如果插件支持)
  function syncTheme() {
    if (bridge) {
      const theme = document.documentElement.getAttribute('data-theme');
      const isDark = theme === 'dark' || theme === 'industrial';
      bridge.port.postMessage({ type: 'bungee:theme', generation: bridge.generation, nonce: bridge.nonce, theme: isDark ? 'dark' : 'light' });
    }
  }

  // 监听主题变化
  onMount(() => {
    const observer = new MutationObserver(() => {
      syncTheme();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      observer.disconnect(); closeBridge(); sourceGeneration += 1; hostLoadArmed = false;
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
      <LoadingIndicator label={sandboxFailure ?? '正在加载插件页面'} size="lg" height="none" />
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
