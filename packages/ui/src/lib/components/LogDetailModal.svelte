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

  function handleBackdropClick(event: MouseEvent) {
    if (event.target === event.currentTarget) {
      onClose();
    }
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

  onMount(async () => {
    try {
      const config = await getConfig();
      bodyLoggingEnabled = config.logging?.body?.enabled || false;
    } catch (error) {
      console.error('Failed to load config:', error);
      bodyLoggingEnabled = false;
    }

    // Auto-load all available data
    if (log.reqHeaderId) loadRequestHeaders();
    if (log.respHeaderId) loadResponseHeaders();
    if (log.reqBodyId) loadRequestBody();
    if (log.respBodyId) loadResponseBody();
  });
</script>

<div
  class="modal modal-open"
  on:click={handleBackdropClick}
  on:keydown={(e) => e.key === 'Escape' && onClose()}
>
  <div class="modal-box max-w-4xl">
    <h3 class="font-bold text-lg mb-4">{$_('logs.detail.title')}</h3>

    <!-- 基本信息 -->
    <div class="grid grid-cols-2 gap-4 mb-6">
      <div>
        <div class="text-sm font-semibold text-gray-500">{$_('logs.detail.requestId')}</div>
        <div class="font-mono text-sm">{log.requestId}</div>
      </div>

      <div>
        <div class="text-sm font-semibold text-gray-500">{$_('logs.detail.timestamp')}</div>
        <div class="text-sm">{formatTime(log.timestamp)}</div>
      </div>

      <div>
        <div class="text-sm font-semibold text-gray-500">{$_('logs.detail.method')}</div>
        <div><span class="badge">{log.method}</span></div>
      </div>

      <div>
        <div class="text-sm font-semibold text-gray-500">{$_('logs.detail.status')}</div>
        <div>
          <span class="badge {getStatusColor(log.status)}">{log.status}</span>
        </div>
      </div>

      <div>
        <div class="text-sm font-semibold text-gray-500">{$_('logs.detail.duration')}</div>
        <div class="text-sm">{formatDuration(log.duration)}</div>
      </div>

      <div>
        <div class="text-sm font-semibold text-gray-500">{$_('logs.detail.success')}</div>
        <div>
          <span class="badge {log.success ? 'badge-success' : 'badge-error'}">
            {log.success ? $_('logs.success') : $_('logs.failed')}
          </span>
        </div>
      </div>
    </div>

    <!-- 请求信息 -->
    <div class="divider">{$_('logs.detail.requestInfo')}</div>
    <div class="mb-6">
      <div class="mb-2">
        <div class="text-sm font-semibold text-gray-500">{$_('logs.detail.path')}</div>
        <div class="font-mono text-sm bg-base-200 p-2 rounded break-all">{log.path}</div>
      </div>

      {#if log.query}
        <div class="mb-2">
          <div class="text-sm font-semibold text-gray-500">{$_('logs.detail.query')}</div>
          <div class="font-mono text-sm bg-base-200 p-2 rounded break-all">{log.query}</div>
        </div>
      {/if}

      {#if log.routePath}
        <div class="mb-2">
          <div class="text-sm font-semibold text-gray-500">{$_('logs.detail.routePath')}</div>
          <div class="font-mono text-sm">{log.routePath}</div>
        </div>
      {/if}
    </div>

    <!-- 上游信息 -->
    {#if log.upstream}
      <div class="divider">{$_('logs.detail.upstreamInfo')}</div>
      <div class="mb-6">
        <div class="mb-2">
          <div class="text-sm font-semibold text-gray-500">{$_('logs.detail.upstream')}</div>
          <div class="font-mono text-sm">{log.upstream}</div>
        </div>

        {#if log.transformer}
          <div class="mb-2">
            <div class="text-sm font-semibold text-gray-500">{$_('logs.detail.transformer')}</div>
            <div class="font-mono text-sm">{log.transformer}</div>
          </div>
        {/if}
      </div>
    {/if}

    <!-- 认证信息 -->
    {#if log.authLevel}
      <div class="divider">{$_('logs.detail.authInfo')}</div>
      <div class="mb-6">
        <div class="mb-2">
          <div class="text-sm font-semibold text-gray-500">{$_('logs.detail.authLevel')}</div>
          <div class="text-sm">{log.authLevel}</div>
        </div>

        <div class="mb-2">
          <div class="text-sm font-semibold text-gray-500">{$_('logs.detail.authResult')}</div>
          <div>
            <span class="badge {log.authSuccess ? 'badge-success' : 'badge-error'}">
              {log.authSuccess ? $_('logs.detail.authSuccess') : $_('logs.detail.authFailed')}
            </span>
          </div>
        </div>
      </div>
    {/if}

    <!-- 处理步骤 -->
    {#if log.processingSteps && log.processingSteps.length > 0}
      <div class="divider">{$_('logs.detail.processingSteps')}</div>
      <div class="mb-6 space-y-1">
        {#each log.processingSteps as step, index}
          <div class="flex items-start gap-2 p-2 bg-base-200 rounded hover:bg-base-300 transition-colors">
            <span class="badge badge-sm badge-primary shrink-0">{index + 1}</span>
            <div class="flex-1 min-w-0">
              <div class="font-semibold text-sm">{step.step}</div>
              {#if step.detail}
                <details class="mt-1">
                  <summary class="cursor-pointer text-xs text-primary hover:underline select-none">
                    查看详情
                  </summary>
                  <pre class="bg-base-100 p-2 rounded text-xs mt-1 overflow-x-auto">{formatJson(step.detail)}</pre>
                </details>
              {/if}
            </div>
            <span class="text-xs opacity-60 whitespace-nowrap shrink-0">{formatTime(step.timestamp)}</span>
          </div>
        {/each}
      </div>
    {/if}

    <!-- 错误信息 -->
    {#if log.errorMessage}
      <div class="divider">{$_('logs.detail.errorInfo')}</div>
      <div class="mb-6">
        <div class="alert alert-error">
          <svg xmlns="http://www.w3.org/2000/svg" class="stroke-current shrink-0 h-6 w-6" fill="none" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span class="font-mono text-sm">{log.errorMessage}</span>
        </div>
      </div>
    {/if}

    <!-- 请求 Headers -->
    {#if log.reqHeaderId}
      <div class="divider">请求 Headers</div>
      <div class="mb-6">
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
            <table class="table table-sm">
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
        {/if}
      </div>
    {/if}

    <!-- 响应 Headers -->
    {#if log.respHeaderId}
      <div class="divider">响应 Headers</div>
      <div class="mb-6">
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
            <table class="table table-sm">
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
        {/if}
      </div>
    {/if}

    <!-- 请求体 -->
    {#if bodyLoggingEnabled && log.reqBodyId}
      <div class="divider">{$_('logs.detail.requestBody')}</div>
      <div class="mb-6">
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
          <pre class="bg-base-200 p-4 rounded overflow-x-auto text-xs">{formatJson(requestBody)}</pre>
        {/if}
      </div>
    {/if}

    <!-- 响应体 -->
    {#if bodyLoggingEnabled && log.respBodyId}
      <div class="divider">{$_('logs.detail.responseBody')}</div>
      <div class="mb-6">
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
          <pre class="bg-base-200 p-4 rounded overflow-x-auto text-xs">{formatJson(responseBody)}</pre>
        {/if}
      </div>
    {/if}

    <!-- 关闭按钮 -->
    <div class="modal-action">
      <button class="btn" on:click={onClose}>{$_('common.close')}</button>
    </div>
  </div>
</div>
