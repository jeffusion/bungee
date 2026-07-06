<script lang="ts">
  import { onMount } from 'svelte';
  import { _ } from '$i18n';
  import JsonBodyViewer from './JsonBodyViewer.svelte';
  import type { LogEntry } from '$api/logs';
  import { loadBodyById, loadHeaderById } from '$api/logs';
  import { getConfig } from '$api/config';
  import { LoadingIndicator, SegmentedControl } from '$components/industrial';

  export let log: LogEntry;
  export let onClose: () => void;

  let requestBody: unknown = undefined;
  let responseBody: unknown = undefined;
  let loadingRequestBody = false;
  let loadingResponseBody = false;
  let requestBodyError: string | null = null;
  let responseBodyError: string | null = null;
  let bodyLoggingEnabled = false;

  let requestHeaders: Record<string, string> | null = null;
  let responseHeaders: Record<string, string> | null = null;
  let loadingRequestHeaders = false;
  let loadingResponseHeaders = false;
  let requestHeadersError: string | null = null;
  let responseHeadersError: string | null = null;

  // 原始请求数据（转换前）
  let originalRequestHeaders: Record<string, string> | null = null;
  let originalRequestBody: unknown = undefined;
  let loadingOriginalRequestHeaders = false;
  let loadingOriginalRequestBody = false;
  let originalRequestHeadersError: string | null = null;
  let originalRequestBodyError: string | null = null;

  // Tab state
  let activeTab: 'original' | 'transformed' | 'response' = 'original';
  let showTimeline = false; // 默认折叠时间轴
  let copyFeedback = false;
  const BODY_VIEWER_DEFAULT_EXPAND_DEPTH = 2;

  function formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleString();
  }

  function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  }

  function getStatusToneClass(status: number): string {
    if (status < 300) return 'border-emerald-500/60 bg-emerald-500/10 text-emerald-300';
    if (status < 400) return 'border-nexus-500/60 bg-nexus-500/10 text-nexus-300';
    if (status < 500) return 'border-amber-500/60 bg-amber-500/10 text-amber-300';
    return 'border-red-500/60 bg-red-500/10 text-red-300';
  }

  function getRequestTypeToneClass(requestType?: string): string {
    if (requestType === 'final') return 'border-emerald-500/60 bg-emerald-500/10 text-emerald-300';
    if (requestType === 'retry') return 'border-amber-500/60 bg-amber-500/10 text-amber-300';
    if (requestType === 'recovery') return 'border-nexus-500/60 bg-nexus-500/10 text-nexus-300';
    return 'border-carbon-500 bg-carbon-700/50 text-zinc-400';
  }

  function chipClass(tone = 'border-carbon-500 bg-carbon-700/50 text-zinc-300'): string {
    return `inline-flex items-center gap-1 border px-2 py-0.5 font-mono text-[10px] uppercase tracking-command ${tone}`;
  }

  function getRequestTypeLabel(requestType?: string): string {
    if (!requestType) return '-';
    return $_(`logs.requestType_${requestType}`);
  }

  // 时间轴辅助函数
  function formatStepName(stepName: string): string {
    // 尝试从 i18n 获取翻译
    const key = `logs.steps.${stepName}`;
    const translated = $_(key);

    // 如果翻译不存在（返回的是 key 本身），则格式化原始名称
    if (translated === key) {
      // 将下划线替换为空格，每个单词首字母大写
      return stepName
        .split('_')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
    }

    return translated;
  }

  function getStepColor(stepName: string): string {
    const name = stepName.toLowerCase();
    if (name.includes('auth')) return 'bg-nexus-500';
    if (name.includes('plugin')) return 'bg-nexus-400';
    if (name.includes('upstream') || name.includes('proxy') || name.includes('selected')) return 'bg-emerald-500';
    if (name.includes('transform') || name.includes('rewrite')) return 'bg-nexus-500';
    if (name.includes('error') || name.includes('failed')) return 'bg-red-500';
    if (name.includes('retry') || name.includes('recover') || name.includes('circuit')) return 'bg-amber-500';
    return 'bg-carbon-500';
  }

  function getStepCategory(stepName: string): string {
    const name = stepName.toLowerCase();
    if (name.includes('auth')) return 'Auth';
    if (name.includes('plugin')) return 'Plugin';
    if (name.includes('upstream') || name.includes('proxy') || name.includes('selected')) return 'Upstream';
    if (name.includes('transform') || name.includes('rewrite')) return 'Transform';
    if (name.includes('retry') || name.includes('recover') || name.includes('circuit')) return 'Retry';
    return 'Other';
  }

  // 计算时间线的持续时间和总耗时
  function getTimelineData() {
    if (!log.processingSteps || log.processingSteps.length === 0) {
      return { durations: [], relativeTime: [], totalDuration: 0 };
    }

    const processingSteps = log.processingSteps;
    const firstTimestamp = processingSteps[0].timestamp;
    const totalDuration = Math.max(log.duration, 1); // 防止除以0

    // 计算每个步骤的持续时间
    const durations = processingSteps.map((step, i) => {
      // 优先使用步骤自带的 duration（后端精确测量）
      if (step.duration !== undefined && step.duration >= 0) {
        return step.duration;
      }

      // 回退：基于时间戳计算（旧数据兼容）
      if (i === processingSteps.length - 1) {
        // 最后一步：从当前步骤到请求完成的时间
        const calculated = totalDuration - (step.timestamp - firstTimestamp);
        return Math.max(0, calculated); // 确保非负
      }
      // 其他步骤：到下一步的时间差
      const calculated = processingSteps[i + 1].timestamp - step.timestamp;
      return Math.max(0, calculated); // 确保非负
    });

    // 计算相对时间（用于定位）
    let cumulativeTime = 0;
    const relativeTime = durations.map((_, i) => {
      if (i === 0) return 0;
      cumulativeTime += durations[i - 1];
      return cumulativeTime;
    });

    // 计算实际总耗时（所有步骤 duration 之和）
    const measuredTotal = durations.reduce((sum, d) => sum + d, 0);

    // 使用测量总耗时和请求总耗时的较大值，确保百分比不会超过 100%
    const effectiveTotal = Math.max(measuredTotal, totalDuration);

    return { durations, relativeTime, totalDuration: effectiveTotal };
  }

  function handleBackdropClick(event: MouseEvent) {
    if (event.target === event.currentTarget) {
      onClose();
    }
  }

  async function copyToClipboard() {
    const data = {
      requestId: log.requestId,
      timestamp: log.timestamp,
      method: log.method,
      path: log.path,
      status: log.status,
      duration: log.duration,
      originalRequestHeaders,
      originalRequestBody,
      requestHeaders,
      requestBody,
      responseHeaders,
      responseBody,
      processingSteps: log.processingSteps,
    };

    try {
      await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      copyFeedback = true;
      setTimeout(() => { copyFeedback = false; }, 2000);
    } catch (error) {
      console.error('Failed to copy:', error);
    }
  }

  async function downloadJson() {
    const data = {
      requestId: log.requestId,
      timestamp: log.timestamp,
      method: log.method,
      path: log.path,
      status: log.status,
      duration: log.duration,
      originalRequestHeaders,
      originalRequestBody,
      requestHeaders,
      requestBody,
      responseHeaders,
      responseBody,
      processingSteps: log.processingSteps,
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `log-${log.requestId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function loadRequestBody() {
    if (!log.reqBodyId || loadingRequestBody || requestBody !== undefined) return;

    loadingRequestBody = true;
    requestBodyError = null;

    try {
      requestBody = await loadBodyById(log.reqBodyId);
    } catch (error) {
      requestBodyError = error instanceof Error ? error.message : 'Failed to load request body';
    } finally {
      loadingRequestBody = false;
    }
  }

  async function loadResponseBody() {
    if (!log.respBodyId || loadingResponseBody || responseBody !== undefined) return;

    loadingResponseBody = true;
    responseBodyError = null;

    try {
      responseBody = await loadBodyById(log.respBodyId);
    } catch (error) {
      responseBodyError = error instanceof Error ? error.message : 'Failed to load response body';
    } finally {
      loadingResponseBody = false;
    }
  }

  async function loadRequestHeaders() {
    if (!log.reqHeaderId || requestHeaders !== null) return;

    loadingRequestHeaders = true;
    requestHeadersError = null;

    try {
      requestHeaders = await loadHeaderById(log.reqHeaderId);
    } catch (error) {
      requestHeadersError = error instanceof Error ? error.message : 'Failed to load request headers';
    } finally {
      loadingRequestHeaders = false;
    }
  }

  async function loadResponseHeaders() {
    if (!log.respHeaderId || responseHeaders !== null) return;

    loadingResponseHeaders = true;
    responseHeadersError = null;

    try {
      responseHeaders = await loadHeaderById(log.respHeaderId);
    } catch (error) {
      responseHeadersError = error instanceof Error ? error.message : 'Failed to load response headers';
    } finally {
      loadingResponseHeaders = false;
    }
  }

  async function loadOriginalRequestHeaders() {
    if (!log.originalReqHeaderId || originalRequestHeaders !== null) return;

    loadingOriginalRequestHeaders = true;
    originalRequestHeadersError = null;

    try {
      originalRequestHeaders = await loadHeaderById(log.originalReqHeaderId);
    } catch (error) {
      originalRequestHeadersError = error instanceof Error ? error.message : 'Failed to load original request headers';
    } finally {
      loadingOriginalRequestHeaders = false;
    }
  }

  async function loadOriginalRequestBody() {
    if (!log.originalReqBodyId || loadingOriginalRequestBody || originalRequestBody !== undefined) return;

    loadingOriginalRequestBody = true;
    originalRequestBodyError = null;

    try {
      originalRequestBody = await loadBodyById(log.originalReqBodyId);
    } catch (error) {
      originalRequestBodyError = error instanceof Error ? error.message : 'Failed to load original request body';
    } finally {
      loadingOriginalRequestBody = false;
    }
  }

  async function loadActiveTabData(tab: 'original' | 'transformed' | 'response'): Promise<void> {
    if (tab === 'original') {
      if (log.originalReqHeaderId) {
        await loadOriginalRequestHeaders();
      }

      if (bodyLoggingEnabled && log.originalReqBodyId) {
        await loadOriginalRequestBody();
      }
      return;
    }

    if (tab === 'transformed') {
      if (log.reqHeaderId) {
        await loadRequestHeaders();
      }

      if (bodyLoggingEnabled && log.reqBodyId) {
        await loadRequestBody();
      }
      return;
    }

    if (log.respHeaderId) {
      await loadResponseHeaders();
    }

    if (bodyLoggingEnabled && log.respBodyId) {
      await loadResponseBody();
    }
  }

  onMount(async () => {
    try {
      const config = await getConfig();
      bodyLoggingEnabled = config.logging?.body?.enabled || false;
    } catch (error) {
      console.error('Failed to load config:', error);
      bodyLoggingEnabled = false;
    }

    await loadActiveTabData(activeTab);
  });

  $: void loadActiveTabData(activeTab);
</script>

<div
  class="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
  role="presentation"
  on:click={handleBackdropClick}
  on:keydown={(e) => e.key === 'Escape' && onClose()}
>
  <div class="nx-panel-raised nx-bracketed relative w-full max-w-6xl h-[90vh] flex flex-col p-0" role="dialog" aria-labelledby="modal-title" aria-modal="true" data-testid="logs-detail-modal">
    <span class="nx-corner nx-corner-tl" aria-hidden="true"></span>
    <span class="nx-corner nx-corner-tr" aria-hidden="true"></span>
    <span class="nx-corner nx-corner-bl" aria-hidden="true"></span>
    <span class="nx-corner nx-corner-br" aria-hidden="true"></span>
    <!-- Header with actions -->
    <div class="flex items-center justify-between px-6 py-3 border-b border-carbon-600 bg-carbon-900">
      <h3 id="modal-title" class="flex items-center gap-2.5 font-mono text-sm font-bold uppercase tracking-command text-zinc-100">
        <span class="nx-stripe" aria-hidden="true"></span>
        {$_('logs.detail.title')}
      </h3>
      <div class="flex items-center gap-2">
        <button
          class="nx-btn-ghost nx-btn-sm"
          on:click={copyToClipboard}
          title={$_('logs.detail.copyToClipboard')}
        >
          {#if copyFeedback}
            <span class="text-emerald-300">{$_('logs.detail.copied')}</span>
          {:else}
            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            <span class="hidden md:inline">{$_('logs.detail.copyToClipboard')}</span>
          {/if}
        </button>
        <button
          class="nx-btn-ghost nx-btn-sm"
          on:click={downloadJson}
          title={$_('logs.detail.downloadJson')}
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          <span class="hidden md:inline">{$_('logs.detail.downloadJson')}</span>
        </button>
        <button class="inline-flex items-center justify-center h-7 w-7 border-2 border-carbon-500 hover:border-nexus-500 hover:text-nexus-300 transition-colors" on:click={onClose} aria-label={$_('common.close')}>
          <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>

    <!-- Scrollable content -->
    <div class="flex-1 overflow-y-auto px-6 py-4 space-y-6">
      <!-- Overview Card -->
      <div class="nx-panel-sunken p-4">
          <h4 class="mb-3 font-mono text-xs font-bold uppercase tracking-command text-zinc-100">{$_('logs.detail.overview')}</h4>
          <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            <div>
              <div class="text-xs opacity-60 mb-1">{$_('logs.detail.status')}</div>
              <span class={chipClass(getStatusToneClass(log.status))}>{log.status}</span>
            </div>
            <div>
              <div class="text-xs opacity-60 mb-1">{$_('logs.detail.method')}</div>
              <span class={chipClass()}>{log.method}</span>
            </div>
            <div>
              <div class="text-xs opacity-60 mb-1">{$_('logs.requestType')}</div>
              <span class={chipClass(getRequestTypeToneClass(log.requestType))} title={$_(`logs.requestType_${log.requestType}_desc`)}>
                {getRequestTypeLabel(log.requestType)}
              </span>
            </div>
            <div>
              <div class="text-xs opacity-60 mb-1">{$_('logs.detail.duration')}</div>
              <div class="font-semibold">{formatDuration(log.duration)}</div>
            </div>
            <div>
              <div class="text-xs opacity-60 mb-1">{$_('logs.detail.timestamp')}</div>
              <div class="text-sm">{formatTime(log.timestamp)}</div>
            </div>
            <div class="col-span-2">
              <div class="text-xs opacity-60 mb-1">{$_('logs.detail.requestId')}</div>
              <div class="font-mono text-xs break-all">{log.requestId}</div>
            </div>
            <div class="col-span-2 md:col-span-3 lg:col-span-6">
              <div class="text-xs opacity-60 mb-1">{$_('logs.detail.processingSteps')}</div>
              <div class="flex gap-2 flex-wrap">
                {#if log.processingSteps && log.processingSteps.length > 0}
                  {#each log.processingSteps.slice(0, 3) as step}
                    <span class={chipClass('border-carbon-500 bg-carbon-900 text-zinc-300')}>{formatStepName(step.step)}</span>
                  {/each}
                  {#if log.processingSteps.length > 3}
                    <span class={chipClass('border-carbon-600 bg-carbon-800 text-zinc-500')}>+{log.processingSteps.length - 3} more</span>
                  {/if}
                {:else}
                  <span class="text-sm opacity-40">No steps recorded</span>
                {/if}
              </div>
            </div>
          </div>
      </div>

      <!-- Processing Timeline (Waterfall View) -->
      {#if log.processingSteps && log.processingSteps.length > 0}
        {@const timelineData = getTimelineData()}

        <div class="nx-panel-sunken p-4">
            <!-- 标题和控制 -->
            <div class="flex items-center justify-between mb-2">
              <div>
                <h4 class="font-mono text-xs font-bold uppercase tracking-command text-zinc-100">{$_('logs.detail.processingTimeline')}</h4>
                <p class="text-xs opacity-60 mt-1">
                  {$_('logs.detail.totalSteps', { values: { count: log.processingSteps.length } })}，
                  {$_('logs.detail.totalDuration', { values: { duration: formatDuration(timelineData.totalDuration) } })}
                </p>
              </div>
              <button
                class="nx-btn-ghost nx-btn-sm"
                on:click={() => showTimeline = !showTimeline}
              >
                {showTimeline ? $_('logs.detail.hideTimeline') : $_('logs.detail.showTimeline')}
              </button>
            </div>

            <!-- 时间轴可视化 -->
            {#if showTimeline}
              <div class="mt-4">
                <!-- 时间刻度 -->
                  <div class="mb-4 flex items-center gap-2 text-xs opacity-50 px-64">
                    <span>0ms</span>
                    <div class="flex-1 border-t border-dashed border-carbon-500/50"></div>
                    <span class="mr-32">{formatDuration(timelineData.totalDuration)}</span>
                  </div>

                <!-- 步骤列表 -->
                {#each log.processingSteps as step, index}
                  {@const duration = timelineData.durations[index]}
                  {@const startTime = timelineData.relativeTime[index]}
                  {@const widthPercent = (duration / timelineData.totalDuration) * 100}
                  {@const leftPercent = (startTime / timelineData.totalDuration) * 100}
                  {@const category = getStepCategory(step.step)}
                  {@const color = getStepColor(step.step)}
                  {@const percentage = ((duration / timelineData.totalDuration) * 100).toFixed(1)}

                  <div class="flex gap-4 group relative mb-3">
                    <!-- 左侧：步骤信息 -->
                    <div class="flex gap-3 shrink-0 w-64">
                      <div class="flex flex-col items-center">
                        <div class="w-3 h-3 {color} z-10"></div>
                        {#if index < log.processingSteps.length - 1}
                          <div class="w-px bg-carbon-500 opacity-40 flex-1 min-h-[2.5rem]"></div>
                        {/if}
                      </div>
                      <div class="flex-1 -mt-0.5">
                        <div class="text-sm font-medium">{formatStepName(step.step)}</div>
                        <div class="text-xs opacity-50 mt-0.5 flex items-center gap-2 flex-wrap">
                          <span class={chipClass('border-carbon-600 bg-carbon-800 text-zinc-400')}>{category}</span>
                          {#if step.detail}
                            {#if step.detail.plugins && Array.isArray(step.detail.plugins)}
                              {#each step.detail.plugins as pluginName}
                                <span class={chipClass('border-nexus-500/60 bg-nexus-500/10 text-nexus-300')}>{pluginName}</span>
                              {/each}
                            {/if}
                            {#if step.detail.target}
                              <span class={chipClass('border-carbon-500 bg-carbon-900 text-zinc-300')} title="Target upstream">{step.detail.target}</span>
                            {/if}
                            {#if step.detail.level}
                              <span class={chipClass('border-amber-500/60 bg-amber-500/10 text-amber-300')}>{step.detail.level}</span>
                            {/if}
                            {#if step.detail.error}
                              <span class={chipClass('border-red-500/60 bg-red-500/10 text-red-300')} title={step.detail.error}>Error</span>
                            {/if}
                          {/if}
                        </div>
                      </div>
                    </div>

                    <!-- 中间：Waterfall 条形图 -->
                    <div class="flex-1 flex items-center">
                      <div class="w-full h-7 relative bg-carbon-700/30 overflow-hidden">
                        <div
                          class="absolute h-full {color} opacity-70 group-hover:opacity-90 transition-all cursor-pointer"
                          style="left: {leftPercent}%; width: {Math.max(widthPercent, 1)}%;"
                          title="{step.step}: {formatDuration(duration)} ({percentage}%)"
                        >
                          {#if widthPercent > 5}
                            <span class="text-xs text-white px-2 leading-7">{percentage}%</span>
                          {/if}
                        </div>
                      </div>
                    </div>

                    <!-- 右侧：时间信息 -->
                    <div class="shrink-0 w-32 text-xs space-y-0.5 font-mono">
                      <div class="opacity-60">+{startTime}ms</div>
                      <div class="font-semibold">{formatDuration(duration)}</div>
                      <div class="opacity-40">{percentage}%</div>
                    </div>
                  </div>
                {/each}
              </div>

              <!-- 图例 -->
              <div class="mt-6 pt-4 border-t border-carbon-600">
                <div class="flex flex-wrap gap-4 text-xs">
                  <div class="flex items-center gap-2">
                    <div class="w-3 h-3 bg-nexus-500"></div>
                    <span>Authentication</span>
                  </div>
                  <div class="flex items-center gap-2">
                    <div class="w-3 h-3 bg-nexus-400"></div>
                    <span>Plugin</span>
                  </div>
                  <div class="flex items-center gap-2">
                    <div class="w-3 h-3 bg-emerald-500"></div>
                    <span>Upstream</span>
                  </div>
                  <div class="flex items-center gap-2">
                    <div class="w-3 h-3 bg-nexus-500"></div>
                    <span>Transform</span>
                  </div>
                  <div class="flex items-center gap-2">
                    <div class="w-3 h-3 bg-red-500"></div>
                    <span>Error</span>
                  </div>
                  <div class="flex items-center gap-2">
                    <div class="w-3 h-3 bg-amber-500"></div>
                    <span>Retry/Recovery</span>
                  </div>
                </div>
              </div>
            {/if}
        </div>
      {/if}

      <!-- Path & Query -->
      <div class="nx-panel-sunken p-4">
          <h4 class="mb-3 font-mono text-xs font-bold uppercase tracking-command text-zinc-100">{$_('logs.detail.requestInfo')}</h4>
          <div class="space-y-2">
            {#if log.transformedPath && log.transformedPath !== log.path}
              <!-- 显示原始路径和转换后的路径 -->
              <div>
                <div class="text-xs opacity-60 mb-1">{$_('logs.detail.originalPath')}</div>
                <div class="font-mono text-sm bg-carbon-700 p-2 break-all">{log.path}</div>
              </div>
              <div>
                <div class="text-xs opacity-60 mb-1">{$_('logs.detail.transformedPath')}</div>
                <div class="font-mono text-sm bg-carbon-700 p-2 break-all">{log.transformedPath}</div>
              </div>
            {:else}
              <!-- 只显示一个路径 -->
              <div>
                <div class="text-xs opacity-60 mb-1">{$_('logs.detail.path')}</div>
                <div class="font-mono text-sm bg-carbon-700 p-2 break-all">{log.path}</div>
              </div>
            {/if}
            {#if log.query}
              <div>
                <div class="text-xs opacity-60 mb-1">{$_('logs.detail.query')}</div>
                <div class="font-mono text-sm bg-carbon-700 p-2 break-all">{log.query}</div>
              </div>
            {/if}
          </div>
      </div>

      <!-- Route & Upstream -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        {#if log.routePath}
          <div class="nx-panel-sunken p-4">
              <h4 class="mb-2 font-mono text-xs font-bold uppercase tracking-command text-zinc-100">{$_('logs.detail.routePath')}</h4>
              <div class="font-mono text-sm">{log.routePath}</div>
          </div>
        {/if}
        {#if log.upstream}
          <div class="nx-panel-sunken p-4">
              <h4 class="mb-2 font-mono text-xs font-bold uppercase tracking-command text-zinc-100">{$_('logs.detail.upstream')}</h4>
              <div class="font-mono text-sm mb-2">{log.upstream}</div>
              {#if log.transformer}
                <div class="text-xs opacity-60">{$_('logs.detail.transformer')}: {log.transformer}</div>
              {/if}
          </div>
        {/if}
      </div>

      <!-- Error Info -->
      {#if log.errorMessage}
        <div class="border-l-2 border-l-red-500 bg-red-500/5 px-3 py-2 font-mono text-[11px] uppercase tracking-command text-red-300">
          <svg xmlns="http://www.w3.org/2000/svg" class="stroke-current shrink-0 h-6 w-6" fill="none" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div>
            <div class="font-bold">{$_('logs.detail.errorInfo')}</div>
            <div class="font-mono text-sm">{log.errorMessage}</div>
          </div>
        </div>
      {/if}

      <!-- Request Data Tabs -->
      <div class="nx-panel-sunken">
          <div class="px-4 pt-4 pb-2 flex justify-center">
            <SegmentedControl
              ariaLabel={$_('logs.detail.title')}
              options={[
                { value: 'original', label: $_('logs.detail.tabOriginalRequest') },
                { value: 'transformed', label: $_('logs.detail.tabFinalRequest') },
                { value: 'response', label: $_('logs.detail.tabResponse') },
              ]}
              value={activeTab}
              on:change={(e) => (activeTab = e.detail as 'original' | 'transformed' | 'response')}
            />
          </div>

          <div class="p-4">
            <!-- Original Request Tab -->
            {#if activeTab === 'original'}
              <div class="space-y-4">
                {#if log.originalReqHeaderId || log.originalReqBodyId}
                  <!-- Original Headers -->
                  {#if log.originalReqHeaderId}
                    <div>
                      <div class="text-sm font-semibold mb-2">{$_('logs.detail.requestHeaders')}</div>
                      {#if loadingOriginalRequestHeaders}
                        <div class="flex items-center gap-2 text-sm text-zinc-300">
                          <LoadingIndicator label="" size="sm" centered={false} />
                          <span class="text-sm">{$_('common.loading')}</span>
                        </div>
                      {:else if originalRequestHeadersError}
                        <div class="border-l-2 border-l-red-500 bg-red-500/5 px-3 py-2 font-mono text-[11px] uppercase tracking-command text-red-300">
                          <span class="text-sm">{originalRequestHeadersError}</span>
                        </div>
                      {:else if originalRequestHeaders !== null}
                        <div class="overflow-x-auto">
                          <table class="w-full text-sm">
                            <thead>
                              <tr>
                                <th class="w-1/3">Name</th>
                                <th>Value</th>
                              </tr>
                            </thead>
                            <tbody>
                              {#each Object.entries(originalRequestHeaders) as [key, value]}
                                <tr>
                                  <td class="font-mono text-xs">{key}</td>
                                  <td class="font-mono text-xs break-all">{value}</td>
                                </tr>
                              {/each}
                            </tbody>
                          </table>
                        </div>
                      {:else}
                        <div class="text-sm opacity-60">{$_('logs.detail.noHeaders')}</div>
                      {/if}
                    </div>
                  {/if}

                  <!-- Original Body -->
                  {#if bodyLoggingEnabled && log.originalReqBodyId}
                    <div>
                      <div class="text-sm font-semibold mb-2">{$_('logs.detail.requestBody')}</div>
                      {#if loadingOriginalRequestBody}
                        <div class="flex items-center gap-2 text-sm text-zinc-300">
                          <LoadingIndicator label="" size="sm" centered={false} />
                          <span class="text-sm">{$_('common.loading')}</span>
                        </div>
                      {:else if originalRequestBodyError}
                        <div class="border-l-2 border-l-red-500 bg-red-500/5 px-3 py-2 font-mono text-[11px] uppercase tracking-command text-red-300">
                          <span class="text-sm">{originalRequestBodyError}</span>
                        </div>
                      {:else if originalRequestBody !== undefined}
                        <JsonBodyViewer
                          value={originalRequestBody}
                          emptyText={$_('logs.detail.noBody')}
                          copyText={$_('common.copy')}
                          copiedText={$_('common.copied')}
                          copyFailedText={$_('common.copyFailed')}
                          copySelectionText={$_('common.copySelection')}
                          copyAllContentText={$_('common.copyAllContent')}
                          expandAllText={$_('common.expandAll')}
                          collapseAllText={$_('common.collapseAll')}
                          defaultExpandDepth={BODY_VIEWER_DEFAULT_EXPAND_DEPTH}
                        />
                      {:else}
                        <div class="text-sm opacity-60">{$_('logs.detail.noBody')}</div>
                      {/if}
                    </div>
                  {/if}
                {:else}
                  <div class="text-center py-8 opacity-60">{$_('logs.detail.noDataAvailable')}</div>
                {/if}
              </div>
            {/if}

            <!-- Transformed Request Tab -->
            {#if activeTab === 'transformed'}
              <div class="space-y-4">
                {#if log.reqHeaderId || log.reqBodyId}
                  <!-- Transformed Headers -->
                  {#if log.reqHeaderId}
                    <div>
                      <div class="text-sm font-semibold mb-2">{$_('logs.detail.requestHeaders')}</div>
                      {#if loadingRequestHeaders}
                        <div class="flex items-center gap-2 text-sm text-zinc-300">
                          <LoadingIndicator label="" size="sm" centered={false} />
                          <span class="text-sm">{$_('common.loading')}</span>
                        </div>
                      {:else if requestHeadersError}
                        <div class="border-l-2 border-l-red-500 bg-red-500/5 px-3 py-2 font-mono text-[11px] uppercase tracking-command text-red-300">
                          <span class="text-sm">{requestHeadersError}</span>
                        </div>
                      {:else if requestHeaders !== null}
                        <div class="overflow-x-auto">
                          <table class="w-full text-sm">
                            <thead>
                              <tr>
                                <th class="w-1/3">Name</th>
                                <th>Value</th>
                              </tr>
                            </thead>
                            <tbody>
                              {#each Object.entries(requestHeaders) as [key, value]}
                                <tr>
                                  <td class="font-mono text-xs">{key}</td>
                                  <td class="font-mono text-xs break-all">{value}</td>
                                </tr>
                              {/each}
                            </tbody>
                          </table>
                        </div>
                      {:else}
                        <div class="text-sm opacity-60">{$_('logs.detail.noHeaders')}</div>
                      {/if}
                    </div>
                  {/if}

                  <!-- Transformed Body -->
                  {#if bodyLoggingEnabled && log.reqBodyId}
                    <div>
                      <div class="text-sm font-semibold mb-2">{$_('logs.detail.requestBody')}</div>
                      {#if loadingRequestBody}
                        <div class="flex items-center gap-2 text-sm text-zinc-300">
                          <LoadingIndicator label="" size="sm" centered={false} />
                          <span class="text-sm">{$_('common.loading')}</span>
                        </div>
                      {:else if requestBodyError}
                        <div class="border-l-2 border-l-red-500 bg-red-500/5 px-3 py-2 font-mono text-[11px] uppercase tracking-command text-red-300">
                          <span class="text-sm">{requestBodyError}</span>
                        </div>
                      {:else if requestBody !== undefined}
                        <JsonBodyViewer
                          value={requestBody}
                          emptyText={$_('logs.detail.noBody')}
                          copyText={$_('common.copy')}
                          copiedText={$_('common.copied')}
                          copyFailedText={$_('common.copyFailed')}
                          copySelectionText={$_('common.copySelection')}
                          copyAllContentText={$_('common.copyAllContent')}
                          expandAllText={$_('common.expandAll')}
                          collapseAllText={$_('common.collapseAll')}
                          defaultExpandDepth={BODY_VIEWER_DEFAULT_EXPAND_DEPTH}
                        />
                      {:else}
                        <div class="text-sm opacity-60">{$_('logs.detail.noBody')}</div>
                      {/if}
                    </div>
                  {/if}
                {:else}
                  <div class="text-center py-8 opacity-60">{$_('logs.detail.noDataAvailable')}</div>
                {/if}
              </div>
            {/if}

            <!-- Response Tab -->
            {#if activeTab === 'response'}
              <div class="space-y-4">
                {#if log.respHeaderId || log.respBodyId}
                  <!-- Response Headers -->
                  {#if log.respHeaderId}
                    <div>
                      <div class="text-sm font-semibold mb-2">{$_('logs.detail.responseHeaders')}</div>
                      {#if loadingResponseHeaders}
                        <div class="flex items-center gap-2 text-sm text-zinc-300">
                          <LoadingIndicator label="" size="sm" centered={false} />
                          <span class="text-sm">{$_('common.loading')}</span>
                        </div>
                      {:else if responseHeadersError}
                        <div class="border-l-2 border-l-red-500 bg-red-500/5 px-3 py-2 font-mono text-[11px] uppercase tracking-command text-red-300">
                          <span class="text-sm">{responseHeadersError}</span>
                        </div>
                      {:else if responseHeaders !== null}
                        <div class="overflow-x-auto">
                          <table class="w-full text-sm">
                            <thead>
                              <tr>
                                <th class="w-1/3">Name</th>
                                <th>Value</th>
                              </tr>
                            </thead>
                            <tbody>
                              {#each Object.entries(responseHeaders) as [key, value]}
                                <tr>
                                  <td class="font-mono text-xs">{key}</td>
                                  <td class="font-mono text-xs break-all">{value}</td>
                                </tr>
                              {/each}
                            </tbody>
                          </table>
                        </div>
                      {:else}
                        <div class="text-sm opacity-60">{$_('logs.detail.noHeaders')}</div>
                      {/if}
                    </div>
                  {/if}

                  <!-- Response Body -->
                  {#if bodyLoggingEnabled && log.respBodyId}
                    <div>
                      <div class="text-sm font-semibold mb-2">{$_('logs.detail.responseBody')}</div>
                      {#if loadingResponseBody}
                        <div class="flex items-center gap-2 text-sm text-zinc-300">
                          <LoadingIndicator label="" size="sm" centered={false} />
                          <span class="text-sm">{$_('common.loading')}</span>
                        </div>
                      {:else if responseBodyError}
                        <div class="border-l-2 border-l-red-500 bg-red-500/5 px-3 py-2 font-mono text-[11px] uppercase tracking-command text-red-300">
                          <span class="text-sm">{responseBodyError}</span>
                        </div>
                      {:else if responseBody !== undefined}
                        <JsonBodyViewer
                          value={responseBody}
                          emptyText={$_('logs.detail.noBody')}
                          copyText={$_('common.copy')}
                          copiedText={$_('common.copied')}
                          copyFailedText={$_('common.copyFailed')}
                          copySelectionText={$_('common.copySelection')}
                          copyAllContentText={$_('common.copyAllContent')}
                          expandAllText={$_('common.expandAll')}
                          collapseAllText={$_('common.collapseAll')}
                          defaultExpandDepth={BODY_VIEWER_DEFAULT_EXPAND_DEPTH}
                        />
                      {:else}
                        <div class="text-sm opacity-60">{$_('logs.detail.noBody')}</div>
                      {/if}
                    </div>
                  {/if}
                {:else}
                  <div class="text-center py-8 opacity-60">{$_('logs.detail.noDataAvailable')}</div>
                {/if}
              </div>
            {/if}
          </div>
      </div>


      <!-- Auth Info -->
      {#if log.authLevel}
        <div class="nx-panel-sunken p-4">
            <h4 class="mb-2 font-mono text-xs font-bold uppercase tracking-command text-zinc-100">{$_('logs.detail.authInfo')}</h4>
            <div class="grid grid-cols-2 gap-4">
              <div>
                <div class="text-xs opacity-60 mb-1">{$_('logs.detail.authLevel')}</div>
                <div class="text-sm">{log.authLevel}</div>
              </div>
              <div>
                <div class="text-xs opacity-60 mb-1">{$_('logs.detail.authResult')}</div>
                <span class={chipClass(log.authSuccess ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-300' : 'border-red-500/60 bg-red-500/10 text-red-300')}>
                  {log.authSuccess ? $_('logs.detail.authSuccess') : $_('logs.detail.authFailed')}
                </span>
              </div>
            </div>
        </div>
      {/if}
    </div>
  </div>
</div>
