<script lang="ts">
  import { onMount } from 'svelte';
  import { _ } from '../i18n';
  import type { LogEntry } from '../api/logs';
  import { loadBodyById, loadHeaderById } from '../api/logs';
  import { getConfig } from '../api/config';

  export let log: LogEntry;
  export let onClose: () => void;

  let requestBody: any = null;
  let responseBody: any = null;
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
  let originalRequestBody: any = null;
  let loadingOriginalRequestHeaders = false;
  let loadingOriginalRequestBody = false;
  let originalRequestHeadersError: string | null = null;
  let originalRequestBodyError: string | null = null;

  // Tab state
  let activeTab: 'original' | 'transformed' | 'response' = 'original';
  let showTimeline = false;
  let copyFeedback = false;

  function formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleString();
  }

  function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  }

  function getStatusColor(status: number): string {
    if (status < 300) return 'badge-success';
    if (status < 400) return 'badge-info';
    if (status < 500) return 'badge-warning';
    return 'badge-error';
  }

  function formatJson(obj: any): string {
    return JSON.stringify(obj, null, 2);
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
  }

  // 计算时间线的持续时间和总耗时
  function getTimelineData() {
    if (!log.processingSteps || log.processingSteps.length === 0) {
      return { durations: [], relativeTime: [], totalDuration: 0 };
    }

    const firstTimestamp = log.processingSteps[0].timestamp;
    const durations = log.processingSteps.map((step, i) => {
      if (i === log.processingSteps.length - 1) {
        // 最后一步：从当前步骤到请求完成的时间
        return log.duration - (step.timestamp - firstTimestamp);
      }
      // 其他步骤：到下一步的时间差
      return log.processingSteps[i + 1].timestamp - step.timestamp;
    });

    const relativeTime = log.processingSteps.map(step => step.timestamp - firstTimestamp);
    const totalDuration = log.duration;

    return { durations, relativeTime, totalDuration };
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
    if (!log.reqBodyId || requestBody !== null) return;

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
    if (!log.respBodyId || responseBody !== null) return;

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
    if (!log.originalReqBodyId || originalRequestBody !== null) return;

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

  onMount(async () => {
    try {
      const config = await getConfig();
      bodyLoggingEnabled = config.logging?.body?.enabled || false;
    } catch (error) {
      console.error('Failed to load config:', error);
      bodyLoggingEnabled = false;
    }

    // Auto-load all available data
    if (log.originalReqHeaderId) loadOriginalRequestHeaders();
    if (log.originalReqBodyId) loadOriginalRequestBody();
    if (log.reqHeaderId) loadRequestHeaders();
    if (log.respHeaderId) loadResponseHeaders();
    if (log.reqBodyId) loadRequestBody();
    if (log.respBodyId) loadResponseBody();
  });
</script>

<div
  class="modal modal-open"
  role="presentation"
  on:click={handleBackdropClick}
  on:keydown={(e) => e.key === 'Escape' && onClose()}
>
  <div class="modal-box max-w-6xl h-[90vh] flex flex-col p-0" role="dialog" aria-labelledby="modal-title" aria-modal="true">
    <!-- Header with actions -->
    <div class="flex items-center justify-between px-6 py-4 border-b border-base-300">
      <h3 id="modal-title" class="font-bold text-xl">{$_('logs.detail.title')}</h3>
      <div class="flex items-center gap-2">
        <button
          class="btn btn-sm btn-ghost"
          on:click={copyToClipboard}
          title={$_('logs.detail.copyToClipboard')}
        >
          {#if copyFeedback}
            <span class="text-success">{$_('logs.detail.copied')}</span>
          {:else}
            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            <span class="hidden md:inline">{$_('logs.detail.copyToClipboard')}</span>
          {/if}
        </button>
        <button
          class="btn btn-sm btn-ghost"
          on:click={downloadJson}
          title={$_('logs.detail.downloadJson')}
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          <span class="hidden md:inline">{$_('logs.detail.downloadJson')}</span>
        </button>
        <button class="btn btn-sm btn-circle btn-ghost" on:click={onClose}>
          <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>

    <!-- Scrollable content -->
    <div class="flex-1 overflow-y-auto px-6 py-4 space-y-6">
      <!-- Overview Card -->
      <div class="card bg-base-200">
        <div class="card-body p-4">
          <h4 class="card-title text-base mb-3">{$_('logs.detail.overview')}</h4>
          <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            <div>
              <div class="text-xs opacity-60 mb-1">{$_('logs.detail.status')}</div>
              <span class="badge {getStatusColor(log.status)} badge-lg">{log.status}</span>
            </div>
            <div>
              <div class="text-xs opacity-60 mb-1">{$_('logs.detail.method')}</div>
              <span class="badge badge-lg">{log.method}</span>
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
          </div>
        </div>
      </div>

      <!-- Path & Query -->
      <div class="card bg-base-200">
        <div class="card-body p-4">
          <h4 class="card-title text-base mb-3">{$_('logs.detail.requestInfo')}</h4>
          <div class="space-y-2">
            {#if log.transformedPath && log.transformedPath !== log.path}
              <!-- 显示原始路径和转换后的路径 -->
              <div>
                <div class="text-xs opacity-60 mb-1">{$_('logs.detail.originalPath')}</div>
                <div class="font-mono text-sm bg-base-300 p-2 rounded break-all">{log.path}</div>
              </div>
              <div>
                <div class="text-xs opacity-60 mb-1">{$_('logs.detail.transformedPath')}</div>
                <div class="font-mono text-sm bg-base-300 p-2 rounded break-all">{log.transformedPath}</div>
              </div>
            {:else}
              <!-- 只显示一个路径 -->
              <div>
                <div class="text-xs opacity-60 mb-1">{$_('logs.detail.path')}</div>
                <div class="font-mono text-sm bg-base-300 p-2 rounded break-all">{log.path}</div>
              </div>
            {/if}
            {#if log.query}
              <div>
                <div class="text-xs opacity-60 mb-1">{$_('logs.detail.query')}</div>
                <div class="font-mono text-sm bg-base-300 p-2 rounded break-all">{log.query}</div>
              </div>
            {/if}
          </div>
        </div>
      </div>

      <!-- Route & Upstream -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        {#if log.routePath}
          <div class="card bg-base-200">
            <div class="card-body p-4">
              <h4 class="card-title text-base mb-2">{$_('logs.detail.routePath')}</h4>
              <div class="font-mono text-sm">{log.routePath}</div>
            </div>
          </div>
        {/if}
        {#if log.upstream}
          <div class="card bg-base-200">
            <div class="card-body p-4">
              <h4 class="card-title text-base mb-2">{$_('logs.detail.upstream')}</h4>
              <div class="font-mono text-sm mb-2">{log.upstream}</div>
              {#if log.transformer}
                <div class="text-xs opacity-60">{$_('logs.detail.transformer')}: {log.transformer}</div>
              {/if}
            </div>
          </div>
        {/if}
      </div>

      <!-- Error Info -->
      {#if log.errorMessage}
        <div class="alert alert-error">
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
      <div class="card bg-base-200">
        <div class="card-body p-0">
          <div class="tabs tabs-boxed bg-transparent p-2 border-b border-base-300">
            <button
              class="tab {activeTab === 'original' ? 'tab-active' : ''}"
              on:click={() => activeTab = 'original'}
            >
              {$_('logs.detail.tabOriginalRequest')}
            </button>
            <button
              class="tab {activeTab === 'transformed' ? 'tab-active' : ''}"
              on:click={() => activeTab = 'transformed'}
            >
              {$_('logs.detail.tabFinalRequest')}
            </button>
            <button
              class="tab {activeTab === 'response' ? 'tab-active' : ''}"
              on:click={() => activeTab = 'response'}
            >
              {$_('logs.detail.tabResponse')}
            </button>
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
                        <div class="flex items-center gap-2">
                          <span class="loading loading-spinner loading-sm"></span>
                          <span class="text-sm">{$_('common.loading')}</span>
                        </div>
                      {:else if originalRequestHeadersError}
                        <div class="alert alert-error">
                          <span class="text-sm">{originalRequestHeadersError}</span>
                        </div>
                      {:else if originalRequestHeaders !== null}
                        <div class="overflow-x-auto">
                          <table class="table table-sm table-zebra">
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
                        <div class="flex items-center gap-2">
                          <span class="loading loading-spinner loading-sm"></span>
                          <span class="text-sm">{$_('common.loading')}</span>
                        </div>
                      {:else if originalRequestBodyError}
                        <div class="alert alert-error">
                          <span class="text-sm">{originalRequestBodyError}</span>
                        </div>
                      {:else if originalRequestBody !== null}
                        <pre class="bg-base-300 p-4 rounded overflow-x-auto text-xs max-h-96">{formatJson(originalRequestBody)}</pre>
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
                        <div class="flex items-center gap-2">
                          <span class="loading loading-spinner loading-sm"></span>
                          <span class="text-sm">{$_('common.loading')}</span>
                        </div>
                      {:else if requestHeadersError}
                        <div class="alert alert-error">
                          <span class="text-sm">{requestHeadersError}</span>
                        </div>
                      {:else if requestHeaders !== null}
                        <div class="overflow-x-auto">
                          <table class="table table-sm table-zebra">
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
                        <div class="flex items-center gap-2">
                          <span class="loading loading-spinner loading-sm"></span>
                          <span class="text-sm">{$_('common.loading')}</span>
                        </div>
                      {:else if requestBodyError}
                        <div class="alert alert-error">
                          <span class="text-sm">{requestBodyError}</span>
                        </div>
                      {:else if requestBody !== null}
                        <pre class="bg-base-300 p-4 rounded overflow-x-auto text-xs max-h-96">{formatJson(requestBody)}</pre>
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
                        <div class="flex items-center gap-2">
                          <span class="loading loading-spinner loading-sm"></span>
                          <span class="text-sm">{$_('common.loading')}</span>
                        </div>
                      {:else if responseHeadersError}
                        <div class="alert alert-error">
                          <span class="text-sm">{responseHeadersError}</span>
                        </div>
                      {:else if responseHeaders !== null}
                        <div class="overflow-x-auto">
                          <table class="table table-sm table-zebra">
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
                        <div class="flex items-center gap-2">
                          <span class="loading loading-spinner loading-sm"></span>
                          <span class="text-sm">{$_('common.loading')}</span>
                        </div>
                      {:else if responseBodyError}
                        <div class="alert alert-error">
                          <span class="text-sm">{responseBodyError}</span>
                        </div>
                      {:else if responseBody !== null}
                        <pre class="bg-base-300 p-4 rounded overflow-x-auto text-xs max-h-96">{formatJson(responseBody)}</pre>
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
      </div>

      <!-- Processing Timeline (Collapsible) -->
      {#if log.processingSteps && log.processingSteps.length > 0}
        {@const timelineData = getTimelineData()}
        <div class="card bg-base-200">
          <div class="card-body p-4">
            <button
              class="flex items-center justify-between w-full text-left"
              on:click={() => showTimeline = !showTimeline}
            >
              <div>
                <h4 class="card-title text-base">{$_('logs.detail.processingTimeline')}</h4>
                <p class="text-xs opacity-60 mt-1">
                  {$_('logs.detail.totalSteps', { values: { count: log.processingSteps.length } })}，
                  {$_('logs.detail.totalDuration', { values: { duration: formatDuration(timelineData.totalDuration) } })}
                </p>
              </div>
              <span class="text-sm opacity-60">
                {showTimeline ? $_('logs.detail.hideTimeline') : $_('logs.detail.showTimeline')}
              </span>
            </button>

            {#if showTimeline}
              <div class="mt-6 relative">
                {#each log.processingSteps as step, index}
                  <div class="flex gap-4 group relative">
                    <!-- 左侧：垂直线 + 圆点 -->
                    <div class="flex flex-col items-center shrink-0">
                      <!-- 圆点 -->
                      <div class="w-3 h-3 rounded-full {index === log.processingSteps.length - 1 ? 'bg-primary' : 'bg-base-content opacity-30'} z-10"></div>
                      <!-- 垂直连接线 -->
                      {#if index < log.processingSteps.length - 1}
                        <div class="w-px bg-base-content opacity-20 flex-1 min-h-[2.5rem]"></div>
                      {/if}
                    </div>

                    <!-- 右侧：内容 -->
                    <div class="flex-1 pb-6 -mt-0.5">
                      <div class="flex items-baseline gap-3 flex-wrap">
                        <!-- 序号和步骤名称 -->
                        <span class="text-xs opacity-40 font-mono">{index + 1}</span>
                        <span class="font-medium text-sm">{step.step}</span>
                        <!-- 相对时间 -->
                        <span class="text-xs opacity-60 font-mono">+{timelineData.relativeTime[index]}ms</span>
                        <!-- 持续时间 -->
                        <span class="text-xs opacity-40">({formatDuration(timelineData.durations[index])})</span>
                      </div>
                      <!-- 绝对时间 -->
                      <div class="text-xs opacity-50 mt-1 font-mono">{formatTime(step.timestamp)}</div>
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        </div>
      {/if}

      <!-- Auth Info -->
      {#if log.authLevel}
        <div class="card bg-base-200">
          <div class="card-body p-4">
            <h4 class="card-title text-base mb-2">{$_('logs.detail.authInfo')}</h4>
            <div class="grid grid-cols-2 gap-4">
              <div>
                <div class="text-xs opacity-60 mb-1">{$_('logs.detail.authLevel')}</div>
                <div class="text-sm">{log.authLevel}</div>
              </div>
              <div>
                <div class="text-xs opacity-60 mb-1">{$_('logs.detail.authResult')}</div>
                <span class="badge {log.authSuccess ? 'badge-success' : 'badge-error'}">
                  {log.authSuccess ? $_('logs.detail.authSuccess') : $_('logs.detail.authFailed')}
                </span>
              </div>
            </div>
          </div>
        </div>
      {/if}
    </div>
  </div>
</div>
