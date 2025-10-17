<script lang="ts">
  import { onMount } from 'svelte';
  import { _ } from '../i18n';
  import type { LogEntry } from '../api/logs';
  import { loadBodyById } from '../api/logs';
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

  onMount(async () => {
    try {
      const config = await getConfig();
      bodyLoggingEnabled = config.logging?.body?.enabled || false;
    } catch (error) {
      console.error('Failed to load config:', error);
      bodyLoggingEnabled = false;
    }
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
      <div class="mb-6">
        <ul class="timeline timeline-vertical">
          {#each log.processingSteps as step, index}
            <li>
              {#if index > 0}
                <hr />
              {/if}
              <div class="timeline-start text-xs">{formatTime(step.timestamp)}</div>
              <div class="timeline-middle">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-5 h-5">
                  <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clip-rule="evenodd" />
                </svg>
              </div>
              <div class="timeline-end timeline-box">
                <div class="font-semibold">{step.step}</div>
                {#if step.detail}
                  <div class="text-xs mt-1">
                    <pre class="bg-base-200 p-2 rounded overflow-x-auto">{formatJson(step.detail)}</pre>
                  </div>
                {/if}
              </div>
              {#if index < log.processingSteps.length - 1}
                <hr />
              {/if}
            </li>
          {/each}
        </ul>
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

    <!-- 请求体 -->
    {#if bodyLoggingEnabled}
      <div class="divider">{$_('logs.detail.requestBody')}</div>
      <div class="mb-6">
        {#if !log.reqBodyId}
          <div class="alert alert-info">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="stroke-current shrink-0 w-6 h-6">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
            </svg>
            <div>
              <div class="font-semibold">{$_('logs.detail.bodyNotRecorded')}</div>
              <div class="text-xs">{$_('logs.detail.bodyNotRecordedReason')}</div>
            </div>
          </div>
        {:else if requestBody === null && !loadingRequestBody}
          <button class="btn btn-sm btn-outline" on:click={loadRequestBody}>
            {$_('logs.detail.loadRequestBody')}
          </button>
        {:else if loadingRequestBody}
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
    {#if bodyLoggingEnabled}
      <div class="divider">{$_('logs.detail.responseBody')}</div>
      <div class="mb-6">
        {#if !log.respBodyId}
          <div class="alert alert-info">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="stroke-current shrink-0 w-6 h-6">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
            </svg>
            <div>
              <div class="font-semibold">{$_('logs.detail.bodyNotRecorded')}</div>
              <div class="text-xs">{$_('logs.detail.bodyNotRecordedReason')}</div>
            </div>
          </div>
        {:else if responseBody === null && !loadingResponseBody}
          <button class="btn btn-sm btn-outline" on:click={loadResponseBody}>
            {$_('logs.detail.loadResponseBody')}
          </button>
        {:else if loadingResponseBody}
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
