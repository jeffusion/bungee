<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { _ } from '../lib/i18n';
  import { queryLogs, exportLogs, createLogStream, type LogEntry, type LogQueryParams } from '../lib/api/logs';
  import LogDetailModal from '../lib/components/LogDetailModal.svelte';

  // 查询参数
  let page = 1;
  let limit = 50;
  let searchTerm = '';
  let method = '';
  let statusFilter = '';
  let successFilter: boolean | undefined = undefined;
  let sortBy: 'timestamp' | 'duration' | 'status' = 'timestamp';
  let sortOrder: 'asc' | 'desc' = 'desc';

  // 时间范围过滤
  let timeRangeType: 'all' | 'recent' | 'custom' = 'recent';
  let recentHours = 1;
  let customStartTime = '';
  let customEndTime = '';

  // 数据
  let logs: LogEntry[] = [];
  let total = 0;
  let totalPages = 0;
  let loading = true;
  let error: string | null = null;

  // 详情模态框
  let selectedLog: LogEntry | null = null;
  let showDetailModal = false;

  // 实时流
  let streamEnabled = false;
  let eventSource: EventSource | null = null;

  // 用于追踪过滤条件是否改变（避免响应式依赖冲突）
  let lastFilters = '';
  let lastCustomTime = '';

  // 加载日志
  async function loadLogs() {
    try {
      loading = true;
      error = null;

      const params: LogQueryParams = {
        page,
        limit,
        sortBy,
        sortOrder,
      };

      // 搜索词
      if (searchTerm.trim()) {
        params.searchTerm = searchTerm.trim();
      }

      // 方法过滤
      if (method) {
        params.method = method;
      }

      // 状态过滤
      if (statusFilter) {
        params.status = parseInt(statusFilter);
      }

      // 成功过滤
      if (successFilter !== undefined) {
        params.success = successFilter;
      }

      // 时间范围过滤
      if (timeRangeType === 'recent') {
        params.endTime = Date.now();
        params.startTime = Date.now() - recentHours * 60 * 60 * 1000;
      } else if (timeRangeType === 'custom') {
        if (customStartTime) {
          params.startTime = new Date(customStartTime).getTime();
        }
        if (customEndTime) {
          params.endTime = new Date(customEndTime).getTime();
        }
      }

      const result = await queryLogs(params);
      logs = result.data;
      total = result.total;
      totalPages = result.totalPages;
    } catch (e: any) {
      error = e.message;
    } finally {
      loading = false;
    }
  }

  // 导出日志
  async function handleExport(format: 'json' | 'csv') {
    try {
      const params: LogQueryParams = {};

      if (searchTerm.trim()) {
        params.searchTerm = searchTerm.trim();
      }
      if (method) {
        params.method = method;
      }
      if (statusFilter) {
        params.status = parseInt(statusFilter);
      }
      if (successFilter !== undefined) {
        params.success = successFilter;
      }

      // 时间范围
      if (timeRangeType === 'recent') {
        params.endTime = Date.now();
        params.startTime = Date.now() - recentHours * 60 * 60 * 1000;
      } else if (timeRangeType === 'custom') {
        if (customStartTime) {
          params.startTime = new Date(customStartTime).getTime();
        }
        if (customEndTime) {
          params.endTime = new Date(customEndTime).getTime();
        }
      }

      const blob = await exportLogs(params, format);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `access-logs-${Date.now()}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      alert(`Export failed: ${e.message}`);
    }
  }

  // 切换实时流
  function toggleStream() {
    if (streamEnabled) {
      // 关闭流
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
      streamEnabled = false;
    } else {
      // 开启流
      eventSource = createLogStream(1000);
      eventSource.onmessage = (event) => {
        const newLog: LogEntry = JSON.parse(event.data);
        // 在列表顶部插入新日志
        logs = [newLog, ...logs];
        // 限制列表长度
        if (logs.length > limit) {
          logs = logs.slice(0, limit);
        }
      };
      eventSource.onerror = () => {
        console.error('Stream connection error');
        toggleStream(); // 关闭流
      };
      streamEnabled = true;
    }
  }

  // 查看详情
  function viewDetail(log: LogEntry) {
    selectedLog = log;
    showDetailModal = true;
  }

  // 格式化时间
  function formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleString();
  }

  // 格式化持续时间
  function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  }

  // 状态码颜色
  function getStatusColor(status: number): string {
    if (status < 300) return 'badge-success';
    if (status < 400) return 'badge-info';
    if (status < 500) return 'badge-warning';
    return 'badge-error';
  }

  onMount(() => {
    loadLogs();
  });

  onDestroy(() => {
    if (eventSource) {
      eventSource.close();
    }
  });

  // 响应式查询 - 当任何查询参数改变时加载日志
  $: page, limit, searchTerm, method, statusFilter, successFilter, sortBy, sortOrder, timeRangeType, recentHours, customStartTime, customEndTime, loadLogs();

  // 当过滤条件改变时，重置到第一页（使用字符串对比避免依赖 page）
  $: {
    const currentFilters = JSON.stringify({ limit, searchTerm, method, statusFilter, successFilter, sortBy, sortOrder, timeRangeType, recentHours });

    if (lastFilters && currentFilters !== lastFilters) {
      page = 1;
    }
    lastFilters = currentFilters;
  }

  // 当自定义时间改变时，重置到第一页
  $: {
    const currentCustomTime = JSON.stringify({ customStartTime, customEndTime });

    if (timeRangeType === 'custom' && lastCustomTime && currentCustomTime !== lastCustomTime) {
      page = 1;
    }
    lastCustomTime = currentCustomTime;
  }
</script>

<div class="p-6">
  <div class="flex justify-between items-center mb-6">
    <h1 class="text-3xl font-bold">{$_('logs.title')}</h1>
    <div class="flex gap-2">
      <button
        class="btn btn-sm {streamEnabled ? 'btn-error' : 'btn-primary'}"
        on:click={toggleStream}
      >
        {streamEnabled ? $_('logs.stopStream') : $_('logs.startStream')}
      </button>
      <div class="dropdown dropdown-end z-50">
        <label tabindex="0" class="btn btn-sm btn-secondary">{$_('logs.export')}</label>
        <ul tabindex="0" class="dropdown-content menu p-2 shadow bg-base-100 rounded-box w-32">
          <li><button on:click={() => handleExport('json')}>JSON</button></li>
          <li><button on:click={() => handleExport('csv')}>CSV</button></li>
        </ul>
      </div>
    </div>
  </div>

  <!-- 过滤器 -->
  <div class="card bg-base-100 shadow-xl mb-6">
    <div class="card-body">
      <h2 class="card-title text-lg">{$_('logs.filters')}</h2>

      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <!-- 搜索词 -->
        <div class="form-control">
          <label class="label">
            <span class="label-text">{$_('logs.searchTerm')}</span>
          </label>
          <input
            type="text"
            bind:value={searchTerm}
            placeholder={$_('logs.searchPlaceholder')}
            class="input input-bordered input-sm"
          />
        </div>

        <!-- 方法 -->
        <div class="form-control">
          <label class="label">
            <span class="label-text">{$_('logs.method')}</span>
          </label>
          <select bind:value={method} class="select select-bordered select-sm">
            <option value="">{$_('logs.allMethods')}</option>
            <option value="GET">GET</option>
            <option value="POST">POST</option>
            <option value="PUT">PUT</option>
            <option value="DELETE">DELETE</option>
            <option value="PATCH">PATCH</option>
          </select>
        </div>

        <!-- 状态码 -->
        <div class="form-control">
          <label class="label">
            <span class="label-text">{$_('logs.status')}</span>
          </label>
          <input
            type="text"
            bind:value={statusFilter}
            placeholder={$_('logs.statusPlaceholder')}
            class="input input-bordered input-sm"
          />
        </div>

        <!-- 成功/失败 -->
        <div class="form-control">
          <label class="label">
            <span class="label-text">{$_('logs.result')}</span>
          </label>
          <select bind:value={successFilter} class="select select-bordered select-sm">
            <option value={undefined}>{$_('logs.allResults')}</option>
            <option value={true}>{$_('logs.success')}</option>
            <option value={false}>{$_('logs.failed')}</option>
          </select>
        </div>

        <!-- 时间范围类型 -->
        <div class="form-control">
          <label class="label">
            <span class="label-text">{$_('logs.timeRange')}</span>
          </label>
          <select bind:value={timeRangeType} class="select select-bordered select-sm">
            <option value="all">{$_('logs.allTime')}</option>
            <option value="recent">{$_('logs.recentTime')}</option>
            <option value="custom">{$_('logs.customTime')}</option>
          </select>
        </div>

        <!-- 最近时间（小时） -->
        {#if timeRangeType === 'recent'}
          <div class="form-control">
            <label class="label">
              <span class="label-text">{$_('logs.recentHours')}</span>
            </label>
            <input
              type="number"
              bind:value={recentHours}
              min="1"
              class="input input-bordered input-sm"
            />
          </div>
        {/if}

        <!-- 自定义时间范围 -->
        {#if timeRangeType === 'custom'}
          <div class="form-control">
            <label class="label">
              <span class="label-text">{$_('logs.startTime')}</span>
            </label>
            <input
              type="datetime-local"
              bind:value={customStartTime}
              class="input input-bordered input-sm"
            />
          </div>

          <div class="form-control">
            <label class="label">
              <span class="label-text">{$_('logs.endTime')}</span>
            </label>
            <input
              type="datetime-local"
              bind:value={customEndTime}
              class="input input-bordered input-sm"
            />
          </div>
        {/if}

        <!-- 排序 -->
        <div class="form-control">
          <label class="label">
            <span class="label-text">{$_('logs.sortBy')}</span>
          </label>
          <select bind:value={sortBy} class="select select-bordered select-sm">
            <option value="timestamp">{$_('logs.sortByTimestamp')}</option>
            <option value="duration">{$_('logs.sortByDuration')}</option>
            <option value="status">{$_('logs.sortByStatus')}</option>
          </select>
        </div>

        <div class="form-control">
          <label class="label">
            <span class="label-text">{$_('logs.sortOrder')}</span>
          </label>
          <select bind:value={sortOrder} class="select select-bordered select-sm">
            <option value="desc">{$_('logs.desc')}</option>
            <option value="asc">{$_('logs.asc')}</option>
          </select>
        </div>
      </div>
    </div>
  </div>

  <!-- 日志列表 -->
  {#if loading && logs.length === 0}
    <div class="flex justify-center items-center h-64">
      <span class="loading loading-spinner loading-lg"></span>
    </div>
  {:else if error}
    <div class="alert alert-error">
      <svg xmlns="http://www.w3.org/2000/svg" class="stroke-current shrink-0 h-6 w-6" fill="none" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <span>{$_('common.error')}: {error}</span>
    </div>
  {:else if logs.length === 0}
    <div class="alert alert-info">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="stroke-current shrink-0 w-6 h-6">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
      </svg>
      <span>{$_('logs.noData')}</span>
    </div>
  {:else}
    <div class="card bg-base-100 shadow-xl">
      <div class="card-body p-0">
        <div class="overflow-x-auto">
          <table class="table table-zebra table-sm">
            <thead>
              <tr>
                <th>{$_('logs.time')}</th>
                <th>{$_('logs.method')}</th>
                <th>{$_('logs.path')}</th>
                <th>{$_('logs.status')}</th>
                <th>{$_('logs.duration')}</th>
                <th>{$_('logs.upstream')}</th>
                <th>{$_('logs.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {#each logs as log (log.requestId)}
                <tr class="hover">
                  <td class="text-xs">{formatTime(log.timestamp)}</td>
                  <td><span class="badge badge-sm">{log.method}</span></td>
                  <td class="font-mono text-xs truncate max-w-xs" title={log.path}>
                    {log.path}
                  </td>
                  <td>
                    <span class="badge badge-sm {getStatusColor(log.status)}">
                      {log.status}
                    </span>
                  </td>
                  <td class="text-xs">{formatDuration(log.duration)}</td>
                  <td class="text-xs truncate max-w-xs" title={log.upstream || '-'}>
                    {log.upstream || '-'}
                  </td>
                  <td>
                    <button
                      class="btn btn-xs btn-ghost"
                      on:click={() => viewDetail(log)}
                    >
                      {$_('logs.viewDetail')}
                    </button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>

        <!-- 分页 -->
        <div class="flex justify-between items-center p-4">
          <div class="text-sm">
            {$_('logs.showing', { values: { start: (page - 1) * limit + 1, end: Math.min(page * limit, total), total } })}
          </div>
          <div class="join">
            <button
              class="join-item btn btn-sm"
              disabled={page <= 1}
              on:click={() => page = page - 1}
            >
              «
            </button>
            <button class="join-item btn btn-sm">
              {$_('logs.page', { values: { page, totalPages } })}
            </button>
            <button
              class="join-item btn btn-sm"
              disabled={page >= totalPages}
              on:click={() => page = page + 1}
            >
              »
            </button>
          </div>
        </div>
      </div>
    </div>
  {/if}
</div>

<!-- 详情模态框 -->
{#if showDetailModal && selectedLog}
  <LogDetailModal
    log={selectedLog}
    onClose={() => {
      showDetailModal = false;
      selectedLog = null;
    }}
  />
{/if}
