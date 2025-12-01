<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { _ } from '../lib/i18n';
  import { queryLogs, exportLogs, type LogEntry, type LogQueryParams } from '../lib/api/logs';
  import LogDetailModal from '../lib/components/LogDetailModal.svelte';

  // 查询参数
  let page = 1;
  let limit = 50;
  let searchTerm = '';
  let method = '';
  let statusFilter = '';
  let successFilter: boolean | undefined = undefined;
  let requestTypeFilter = '';
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

  // 自动刷新配置
  let autoRefreshEnabled = true;
  let refreshInterval: '5s' | '10s' | '30s' | '60s' = '30s';
  let refreshTimer: number | null = null;
  let lastRefreshTime: number = 0;
  let showRefreshHint = false;

  // 刷新间隔映射（毫秒）
  const REFRESH_INTERVALS = {
    '5s': 5000,
    '10s': 10000,
    '30s': 30000,
    '60s': 60000
  };

  // 用于追踪过滤条件是否改变（避免响应式依赖冲突）
  let lastFilters = '';
  let lastCustomTime = '';

  // 高级筛选折叠状态
  let advancedFiltersExpanded = false;

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

      // 请求类型过滤
      if (requestTypeFilter) {
        params.requestType = requestTypeFilter as 'final' | 'retry' | 'recovery';
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
      if (requestTypeFilter) {
        params.requestType = requestTypeFilter as 'final' | 'retry' | 'recovery';
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

  // 请求类型颜色
  function getRequestTypeColor(requestType?: string): string {
    if (requestType === 'final') return 'badge-success';
    if (requestType === 'retry') return 'badge-warning';
    if (requestType === 'recovery') return 'badge-info';
    return 'badge-ghost';
  }

  // 请求类型标签
  function getRequestTypeLabel(requestType?: string): string {
    if (!requestType) return '-';
    return $_(`logs.requestType_${requestType}`);
  }

  // 清除所有筛选
  function clearAllFilters() {
    searchTerm = '';
    method = '';
    statusFilter = '';
    successFilter = undefined;
    requestTypeFilter = '';
    timeRangeType = 'recent';
    recentHours = 1;
    customStartTime = '';
    customEndTime = '';
    sortBy = 'timestamp';
    sortOrder = 'desc';
    page = 1;
  }

  // 保存折叠状态到 localStorage
  function saveFiltersState() {
    localStorage.setItem('logsAdvancedFiltersExpanded', String(advancedFiltersExpanded));
  }

  // 检查是否有激活的过滤条件
  function hasActiveFilters(): boolean {
    return !!(
      searchTerm ||
      method ||
      statusFilter ||
      successFilter !== undefined ||
      requestTypeFilter
    );
  }

  // 启动自动刷新
  function startAutoRefresh() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
    }

    if (autoRefreshEnabled) {
      const interval = REFRESH_INTERVALS[refreshInterval];
      refreshTimer = window.setInterval(() => {
        if (document.visibilityState === 'visible') {
          // 如果有过滤条件，不自动刷新，只显示提示
          if (hasActiveFilters()) {
            showRefreshHint = true;
          } else {
            loadLogs();
            lastRefreshTime = Date.now();
            showRefreshHint = false;
          }
        }
      }, interval);
    }
  }

  // 停止自动刷新
  function stopAutoRefresh() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  // 手动刷新
  async function manualRefresh() {
    await loadLogs();
    lastRefreshTime = Date.now();
    showRefreshHint = false;
  }

  // 页面可见性变化处理
  function handleVisibilityChange() {
    if (document.visibilityState === 'visible') {
      // 页面恢复可见时，如果距离上次刷新超过间隔，立即刷新
      const elapsed = Date.now() - lastRefreshTime;
      const interval = REFRESH_INTERVALS[refreshInterval];
      if (elapsed >= interval) {
        loadLogs();
      }
      if (autoRefreshEnabled) {
        startAutoRefresh();
      }
    } else {
      // 页面不可见时暂停刷新
      stopAutoRefresh();
    }
  }

  onMount(() => {
    // 恢复高级筛选折叠状态
    const saved = localStorage.getItem('logsAdvancedFiltersExpanded');
    if (saved !== null) {
      advancedFiltersExpanded = saved === 'true';
    }

    // 恢复刷新配置
    const savedInterval = localStorage.getItem('logsRefreshInterval');
    if (savedInterval) {
      refreshInterval = savedInterval as typeof refreshInterval;
    }

    const savedAutoRefresh = localStorage.getItem('logsAutoRefresh');
    if (savedAutoRefresh !== null) {
      autoRefreshEnabled = savedAutoRefresh === 'true';
    }

    // 初始加载
    loadLogs();

    // 启动自动刷新
    startAutoRefresh();

    // 监听页面可见性变化
    document.addEventListener('visibilitychange', handleVisibilityChange);
  });

  onDestroy(() => {
    stopAutoRefresh();
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  });

  // 响应式启动/停止刷新
  $: {
    if (autoRefreshEnabled) {
      startAutoRefresh();
    } else {
      stopAutoRefresh();
    }
  }

  // 保存配置到 localStorage
  $: {
    localStorage.setItem('logsRefreshInterval', refreshInterval);
    localStorage.setItem('logsAutoRefresh', String(autoRefreshEnabled));
  }

  // 计算激活的筛选条件数量
  $: activeFiltersCount = [
    searchTerm.trim(),
    method,
    statusFilter,
    successFilter !== undefined,
    requestTypeFilter,
    timeRangeType !== 'all' && timeRangeType !== 'recent' || recentHours !== 1,
    sortBy !== 'timestamp' || sortOrder !== 'desc'
  ].filter(Boolean).length;

  // 响应式查询 - 当任何查询参数改变时加载日志
  $: page, limit, searchTerm, method, statusFilter, successFilter, requestTypeFilter, sortBy, sortOrder, timeRangeType, recentHours, customStartTime, customEndTime, loadLogs();

  // 当过滤条件改变时，重置到第一页（使用字符串对比避免依赖 page）
  $: {
    const currentFilters = JSON.stringify({ limit, searchTerm, method, statusFilter, successFilter, requestTypeFilter, sortBy, sortOrder, timeRangeType, recentHours });

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
  <!-- 简洁标题行 -->
  <div class="mb-6">
    <h1 class="text-2xl lg:text-3xl font-bold">{$_('logs.title')}</h1>
  </div>

  <!-- 新数据提示 -->
  {#if showRefreshHint}
    <div class="alert alert-info shadow-lg mb-4">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="stroke-current shrink-0 w-6 h-6">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
      </svg>
      <span>{$_('logs.newDataAvailable')}</span>
      <div class="flex-none">
        <button class="btn btn-sm" on:click={manualRefresh}>
          {$_('common.refresh')}
        </button>
      </div>
    </div>
  {/if}

  <!-- 统一操作栏（响应式设计） -->
  <div class="mb-6">
    <!-- 操作控制行 -->
    <div class="flex items-center gap-2 mb-3">
      <!-- 搜索框（弹性伸缩） -->
      <div class="flex-1 min-w-[200px] xl:max-w-md">
        <input
          type="text"
          bind:value={searchTerm}
          placeholder={$_('logs.searchPlaceholder')}
          class="input input-bordered input-sm w-full"
        />
      </div>

      <!-- 宽屏布局（≥1280px）：所有控件展开 -->
      <div class="hidden xl:flex items-center gap-2 flex-wrap flex-1">
        <!-- 左侧：过滤按钮组 -->
        <div class="flex items-center gap-2 flex-wrap">
          <!-- Method 下拉 -->
          <div class="dropdown dropdown-end">
            <div
              role="button"
              tabindex="0"
              class="btn btn-sm {method ? 'btn-primary' : 'btn-ghost'} gap-1"
            >
              {$_('logs.method')}
              {#if method}
                <span class="badge badge-sm">1</span>
              {/if}
              <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
              </svg>
            </div>
            <ul role="menu" tabindex="0" class="dropdown-content menu p-2 shadow bg-base-100 rounded-box w-40 z-[1]">
              <li><button on:click={() => method = ''}>{$_('logs.allMethods')}</button></li>
              <li><button on:click={() => method = 'GET'} class:active={method === 'GET'}>GET</button></li>
              <li><button on:click={() => method = 'POST'} class:active={method === 'POST'}>POST</button></li>
              <li><button on:click={() => method = 'PUT'} class:active={method === 'PUT'}>PUT</button></li>
              <li><button on:click={() => method = 'DELETE'} class:active={method === 'DELETE'}>DELETE</button></li>
              <li><button on:click={() => method = 'PATCH'} class:active={method === 'PATCH'}>PATCH</button></li>
            </ul>
          </div>

          <!-- Status 下拉 -->
          <div class="dropdown dropdown-end">
            <div
              role="button"
              tabindex="0"
              class="btn btn-sm {statusFilter ? 'btn-primary' : 'btn-ghost'} gap-1"
            >
              {$_('logs.status')}
              {#if statusFilter}
                <span class="badge badge-sm">1</span>
              {/if}
              <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
              </svg>
            </div>
            <div role="menu" tabindex="0" class="dropdown-content bg-base-100 rounded-box p-3 shadow-lg w-48 z-[1]">
              <div class="form-control">
                <div class="label py-1">
                  <span class="label-text text-xs">{$_('logs.statusPlaceholder')}</span>
                </div>
                <input
                  type="text"
                  bind:value={statusFilter}
                  placeholder="200, 404, 500"
                  class="input input-bordered input-sm"
                />
              </div>
            </div>
          </div>

          <!-- Result 下拉 -->
          <div class="dropdown dropdown-end">
            <div
              role="button"
              tabindex="0"
              class="btn btn-sm {successFilter !== undefined ? 'btn-primary' : 'btn-ghost'} gap-1"
            >
              {$_('logs.result')}
              {#if successFilter !== undefined}
                <span class="badge badge-sm">1</span>
              {/if}
              <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
              </svg>
            </div>
            <ul role="menu" tabindex="0" class="dropdown-content menu p-2 shadow bg-base-100 rounded-box w-40 z-[1]">
              <li><button on:click={() => successFilter = undefined}>{$_('logs.allResults')}</button></li>
              <li><button on:click={() => successFilter = true} class:active={successFilter === true}>{$_('logs.success')}</button></li>
              <li><button on:click={() => successFilter = false} class:active={successFilter === false}>{$_('logs.failed')}</button></li>
            </ul>
          </div>

          <!-- More Filters 下拉 -->
        <div class="dropdown dropdown-end">
          <div
            role="button"
            tabindex="0"
            class="btn btn-sm {requestTypeFilter || timeRangeType !== 'recent' || recentHours !== 1 || sortBy !== 'timestamp' || sortOrder !== 'desc' ? 'btn-primary' : 'btn-ghost'} gap-1"
          >
            {$_('logs.moreFilters')}
            {#if requestTypeFilter || timeRangeType !== 'recent' || recentHours !== 1 || sortBy !== 'timestamp' || sortOrder !== 'desc'}
              <span class="badge badge-sm">
                {[requestTypeFilter, timeRangeType !== 'recent' || recentHours !== 1, sortBy !== 'timestamp' || sortOrder !== 'desc'].filter(Boolean).length}
              </span>
            {/if}
            <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
            </svg>
          </div>
          <div role="menu" tabindex="0" class="dropdown-content bg-base-100 rounded-box p-4 shadow-lg w-80 z-[1]">
            <div class="space-y-3">
              <!-- 请求类型 -->
              <div class="form-control">
                <div class="label py-1">
                  <span class="label-text text-xs font-semibold">{$_('logs.requestTypeFilter')}</span>
                </div>
                <select bind:value={requestTypeFilter} class="select select-bordered select-sm">
                  <option value="">{$_('logs.requestType_all')}</option>
                  <option value="final">{$_('logs.requestType_final')}</option>
                  <option value="retry">{$_('logs.requestType_retry')}</option>
                  <option value="recovery">{$_('logs.requestType_recovery')}</option>
                </select>
              </div>

              <!-- 时间范围 -->
              <div class="form-control">
                <div class="label py-1">
                  <span class="label-text text-xs font-semibold">{$_('logs.timeRange')}</span>
                </div>
                <select bind:value={timeRangeType} class="select select-bordered select-sm">
                  <option value="all">{$_('logs.allTime')}</option>
                  <option value="recent">{$_('logs.recentTime')}</option>
                  <option value="custom">{$_('logs.customTime')}</option>
                </select>
              </div>

              <!-- 最近时间（小时） -->
              {#if timeRangeType === 'recent'}
                <div class="form-control">
                  <div class="label py-1">
                    <span class="label-text text-xs font-semibold">{$_('logs.recentHours')}</span>
                  </div>
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
                  <div class="label py-1">
                    <span class="label-text text-xs font-semibold">{$_('logs.startTime')}</span>
                  </div>
                  <input
                    type="datetime-local"
                    bind:value={customStartTime}
                    class="input input-bordered input-sm"
                  />
                </div>

                <div class="form-control">
                  <div class="label py-1">
                    <span class="label-text text-xs font-semibold">{$_('logs.endTime')}</span>
                  </div>
                  <input
                    type="datetime-local"
                    bind:value={customEndTime}
                    class="input input-bordered input-sm"
                  />
                </div>
              {/if}

              <!-- 排序 -->
              <div class="divider my-2"></div>
              <div class="form-control">
                <div class="label py-1">
                  <span class="label-text text-xs font-semibold">{$_('logs.sortBy')}</span>
                </div>
                <div class="flex gap-2">
                  <select bind:value={sortBy} class="select select-bordered select-sm flex-1">
                    <option value="timestamp">{$_('logs.sortByTimestamp')}</option>
                    <option value="duration">{$_('logs.sortByDuration')}</option>
                    <option value="status">{$_('logs.sortByStatus')}</option>
                  </select>
                  <select bind:value={sortOrder} class="select select-bordered select-sm w-24">
                    <option value="desc">{$_('logs.desc')}</option>
                    <option value="asc">{$_('logs.asc')}</option>
                  </select>
                </div>
              </div>
            </div>
          </div>
        </div>
        </div>

        <!-- 弹性空间 -->
        <div class="flex-1"></div>

        <!-- 右侧：刷新和操作按钮组 -->
        <div class="flex items-center gap-2 flex-wrap">
          <!-- 刷新设置下拉菜单 -->
          <div class="dropdown dropdown-end">
            <div role="button" tabindex="0" class="btn btn-sm btn-outline gap-1">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                class="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                />
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                />
              </svg>
              {#if autoRefreshEnabled}
                <span class="badge badge-sm badge-primary">{refreshInterval}</span>
              {/if}
            </div>
            <div role="menu" tabindex="0" class="dropdown-content bg-base-100 rounded-box p-4 shadow-lg w-64 z-[1]">
              <div class="space-y-3">
                <!-- Auto Refresh Toggle -->
                <div class="form-control">
                  <label class="label cursor-pointer">
                    <span class="label-text">{$_('logs.autoRefresh')}</span>
                    <input
                      type="checkbox"
                      class="toggle toggle-primary toggle-sm"
                      bind:checked={autoRefreshEnabled}
                    />
                  </label>
                </div>

                <!-- Refresh Interval -->
                {#if autoRefreshEnabled}
                  <div class="form-control">
                    <div class="label py-1">
                      <span class="label-text text-xs font-semibold">{$_('logs.refreshInterval')}</span>
                    </div>
                    <select
                      class="select select-bordered select-sm"
                      bind:value={refreshInterval}
                    >
                      <option value="5s">{$_('logs.refreshEvery5s')}</option>
                      <option value="10s">{$_('logs.refreshEvery10s')}</option>
                      <option value="30s">{$_('logs.refreshEvery30s')}</option>
                      <option value="60s">{$_('logs.refreshEvery60s')}</option>
                    </select>
                  </div>
                {/if}
              </div>
            </div>
          </div>

          <!-- 手动刷新按钮 -->
          <button
            type="button"
            class="btn btn-sm btn-outline gap-2"
            on:click={manualRefresh}
            disabled={loading}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              class="h-4 w-4"
              class:animate-spin={loading}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
            <span>{$_('common.refresh')}</span>
          </button>

          <!-- 导出按钮 -->
          <div class="dropdown dropdown-end">
            <div role="button" tabindex="0" class="btn btn-sm btn-secondary gap-2">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              <span>{$_('logs.export')}</span>
            </div>
            <ul role="menu" tabindex="0" class="dropdown-content menu p-2 shadow bg-base-100 rounded-box w-32 z-[1]">
              <li><button on:click={() => handleExport('json')}>JSON</button></li>
              <li><button on:click={() => handleExport('csv')}>CSV</button></li>
            </ul>
          </div>

          <!-- Clear All 按钮 -->
          {#if activeFiltersCount > 0}
            <button
              type="button"
              class="btn btn-sm btn-ghost gap-1"
              on:click={clearAllFilters}
            >
              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
              {$_('logs.clearFilters')}
            </button>
          {/if}
        </div>
      </div>

      <!-- 中屏布局（768-1280px）：部分收起 -->
      <div class="hidden md:flex xl:hidden items-center gap-2">
        <!-- 筛选菜单（合并所有过滤选项） -->
        <div class="dropdown dropdown-end">
          <div
            role="button"
            tabindex="0"
            class="btn btn-sm {method || statusFilter || successFilter !== undefined || requestTypeFilter || timeRangeType !== 'recent' || recentHours !== 1 || sortBy !== 'timestamp' || sortOrder !== 'desc' ? 'btn-primary' : 'btn-ghost'} gap-1"
          >
            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
            </svg>
            {$_('logs.filters')}
            {#if method || statusFilter || successFilter !== undefined || requestTypeFilter || timeRangeType !== 'recent' || recentHours !== 1 || sortBy !== 'timestamp' || sortOrder !== 'desc'}
              <span class="badge badge-sm">
                {[method, statusFilter, successFilter !== undefined, requestTypeFilter, timeRangeType !== 'recent' || recentHours !== 1, sortBy !== 'timestamp' || sortOrder !== 'desc'].filter(Boolean).length}
              </span>
            {/if}
          </div>
          <div role="menu" tabindex="0" class="dropdown-content bg-base-100 rounded-box p-4 shadow-lg w-80 z-[1]">
            <div class="space-y-3">
              <!-- Method -->
              <div class="form-control">
                <div class="label py-1">
                  <span class="label-text text-xs font-semibold">{$_('logs.method')}</span>
                </div>
                <select bind:value={method} class="select select-bordered select-sm">
                  <option value="">{$_('logs.allMethods')}</option>
                  <option value="GET">GET</option>
                  <option value="POST">POST</option>
                  <option value="PUT">PUT</option>
                  <option value="DELETE">DELETE</option>
                  <option value="PATCH">PATCH</option>
                </select>
              </div>

              <!-- Status -->
              <div class="form-control">
                <div class="label py-1">
                  <span class="label-text text-xs font-semibold">{$_('logs.status')}</span>
                </div>
                <input
                  type="text"
                  bind:value={statusFilter}
                  placeholder="200, 404, 500"
                  class="input input-bordered input-sm"
                />
              </div>

              <!-- Result -->
              <div class="form-control">
                <div class="label py-1">
                  <span class="label-text text-xs font-semibold">{$_('logs.result')}</span>
                </div>
                <select bind:value={successFilter} class="select select-bordered select-sm">
                  <option value={undefined}>{$_('logs.allResults')}</option>
                  <option value={true}>{$_('logs.success')}</option>
                  <option value={false}>{$_('logs.failed')}</option>
                </select>
              </div>

              <div class="divider my-2"></div>

              <!-- Request Type -->
              <div class="form-control">
                <div class="label py-1">
                  <span class="label-text text-xs font-semibold">{$_('logs.requestTypeFilter')}</span>
                </div>
                <select bind:value={requestTypeFilter} class="select select-bordered select-sm">
                  <option value="">{$_('logs.requestType_all')}</option>
                  <option value="final">{$_('logs.requestType_final')}</option>
                  <option value="retry">{$_('logs.requestType_retry')}</option>
                  <option value="recovery">{$_('logs.requestType_recovery')}</option>
                </select>
              </div>

              <!-- Time Range -->
              <div class="form-control">
                <div class="label py-1">
                  <span class="label-text text-xs font-semibold">{$_('logs.timeRange')}</span>
                </div>
                <select bind:value={timeRangeType} class="select select-bordered select-sm">
                  <option value="all">{$_('logs.allTime')}</option>
                  <option value="recent">{$_('logs.recentTime')}</option>
                  <option value="custom">{$_('logs.customTime')}</option>
                </select>
              </div>

              {#if timeRangeType === 'recent'}
                <div class="form-control">
                  <div class="label py-1">
                    <span class="label-text text-xs font-semibold">{$_('logs.recentHours')}</span>
                  </div>
                  <input
                    type="number"
                    bind:value={recentHours}
                    min="1"
                    class="input input-bordered input-sm"
                  />
                </div>
              {/if}

              {#if timeRangeType === 'custom'}
                <div class="form-control">
                  <div class="label py-1">
                    <span class="label-text text-xs font-semibold">{$_('logs.startTime')}</span>
                  </div>
                  <input
                    type="datetime-local"
                    bind:value={customStartTime}
                    class="input input-bordered input-sm"
                  />
                </div>

                <div class="form-control">
                  <div class="label py-1">
                    <span class="label-text text-xs font-semibold">{$_('logs.endTime')}</span>
                  </div>
                  <input
                    type="datetime-local"
                    bind:value={customEndTime}
                    class="input input-bordered input-sm"
                  />
                </div>
              {/if}

              <!-- Sort -->
              <div class="divider my-2"></div>
              <div class="form-control">
                <div class="label py-1">
                  <span class="label-text text-xs font-semibold">{$_('logs.sortBy')}</span>
                </div>
                <div class="flex gap-2">
                  <select bind:value={sortBy} class="select select-bordered select-sm flex-1">
                    <option value="timestamp">{$_('logs.sortByTimestamp')}</option>
                    <option value="duration">{$_('logs.sortByDuration')}</option>
                    <option value="status">{$_('logs.sortByStatus')}</option>
                  </select>
                  <select bind:value={sortOrder} class="select select-bordered select-sm w-24">
                    <option value="desc">{$_('logs.desc')}</option>
                    <option value="asc">{$_('logs.asc')}</option>
                  </select>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 刷新菜单（合并刷新控制） -->
        <div class="dropdown dropdown-end">
          <div role="button" tabindex="0" class="btn btn-sm btn-ghost gap-2">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              class="h-4 w-4"
              class:animate-spin={loading}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
            {$_('common.refresh')}
          </div>
          <div role="menu" tabindex="0" class="dropdown-content bg-base-100 rounded-box p-4 shadow-lg w-72 z-[1]">
            <div class="space-y-3">
              <!-- Auto Refresh Toggle -->
              <div class="form-control">
                <label class="label cursor-pointer">
                  <span class="label-text">{$_('logs.autoRefresh')}</span>
                  <input
                    type="checkbox"
                    class="toggle toggle-primary toggle-sm"
                    bind:checked={autoRefreshEnabled}
                  />
                </label>
              </div>

              <!-- Refresh Interval -->
              {#if autoRefreshEnabled}
                <div class="form-control">
                  <div class="label py-1">
                    <span class="label-text text-xs font-semibold">{$_('logs.refreshInterval')}</span>
                  </div>
                  <select
                    class="select select-bordered select-sm"
                    bind:value={refreshInterval}
                  >
                    <option value="5s">{$_('logs.refreshEvery5s')}</option>
                    <option value="10s">{$_('logs.refreshEvery10s')}</option>
                    <option value="30s">{$_('logs.refreshEvery30s')}</option>
                    <option value="60s">{$_('logs.refreshEvery60s')}</option>
                  </select>
                </div>
              {/if}

              <!-- Manual Refresh Button -->
              <div class="divider my-2"></div>
              <button
                type="button"
                class="btn btn-sm btn-primary w-full gap-2"
                on:click={manualRefresh}
                disabled={loading}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  class="h-4 w-4"
                  class:animate-spin={loading}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                  />
                </svg>
                {$_('common.refresh')}
              </button>

              <!-- Last Refresh Time -->
              {#if lastRefreshTime > 0}
                <div class="text-xs text-gray-500 text-center">
                  {$_('logs.lastRefreshed')}: {new Date(lastRefreshTime).toLocaleTimeString()}
                </div>
              {/if}
            </div>
          </div>
        </div>

        <!-- 导出按钮 -->
        <div class="dropdown dropdown-end">
          <div role="button" tabindex="0" class="btn btn-sm btn-secondary gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            {$_('logs.export')}
          </div>
          <ul role="menu" tabindex="0" class="dropdown-content menu p-2 shadow bg-base-100 rounded-box w-32 z-[1]">
            <li><button on:click={() => handleExport('json')}>JSON</button></li>
            <li><button on:click={() => handleExport('csv')}>CSV</button></li>
          </ul>
        </div>

        <!-- Clear All 按钮 -->
        {#if activeFiltersCount > 0}
          <button
            type="button"
            class="btn btn-sm btn-ghost gap-1"
            on:click={clearAllFilters}
          >
            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
            {$_('logs.clearFilters')}
          </button>
        {/if}
      </div>

      <!-- 窄屏布局（<768px）：全部收起到统一菜单 -->
      <div class="flex md:hidden items-center gap-2">
        <!-- 操作菜单（包含所有功能） -->
        <div class="dropdown dropdown-end">
          <div role="button" tabindex="0" class="btn btn-sm btn-ghost gap-1">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
            {$_('logs.actions')}
            {#if method || statusFilter || successFilter !== undefined || requestTypeFilter || timeRangeType !== 'recent' || recentHours !== 1 || sortBy !== 'timestamp' || sortOrder !== 'desc' || autoRefreshEnabled}
              <span class="badge badge-sm badge-primary"></span>
            {/if}
          </div>
          <div role="menu" tabindex="0" class="dropdown-content bg-base-100 rounded-box p-4 shadow-lg w-80 z-[1]">
            <div class="space-y-3">
              <h3 class="font-semibold text-sm">{$_('logs.filters')}</h3>

              <!-- Method -->
              <div class="form-control">
                <div class="label py-1">
                  <span class="label-text text-xs font-semibold">{$_('logs.method')}</span>
                </div>
                <select bind:value={method} class="select select-bordered select-sm">
                  <option value="">{$_('logs.allMethods')}</option>
                  <option value="GET">GET</option>
                  <option value="POST">POST</option>
                  <option value="PUT">PUT</option>
                  <option value="DELETE">DELETE</option>
                  <option value="PATCH">PATCH</option>
                </select>
              </div>

              <!-- Status -->
              <div class="form-control">
                <div class="label py-1">
                  <span class="label-text text-xs font-semibold">{$_('logs.status')}</span>
                </div>
                <input
                  type="text"
                  bind:value={statusFilter}
                  placeholder="200, 404, 500"
                  class="input input-bordered input-sm"
                />
              </div>

              <!-- Result -->
              <div class="form-control">
                <div class="label py-1">
                  <span class="label-text text-xs font-semibold">{$_('logs.result')}</span>
                </div>
                <select bind:value={successFilter} class="select select-bordered select-sm">
                  <option value={undefined}>{$_('logs.allResults')}</option>
                  <option value={true}>{$_('logs.success')}</option>
                  <option value={false}>{$_('logs.failed')}</option>
                </select>
              </div>

              <!-- Request Type -->
              <div class="form-control">
                <div class="label py-1">
                  <span class="label-text text-xs font-semibold">{$_('logs.requestTypeFilter')}</span>
                </div>
                <select bind:value={requestTypeFilter} class="select select-bordered select-sm">
                  <option value="">{$_('logs.requestType_all')}</option>
                  <option value="final">{$_('logs.requestType_final')}</option>
                  <option value="retry">{$_('logs.requestType_retry')}</option>
                  <option value="recovery">{$_('logs.requestType_recovery')}</option>
                </select>
              </div>

              <!-- Time Range -->
              <div class="form-control">
                <div class="label py-1">
                  <span class="label-text text-xs font-semibold">{$_('logs.timeRange')}</span>
                </div>
                <select bind:value={timeRangeType} class="select select-bordered select-sm">
                  <option value="all">{$_('logs.allTime')}</option>
                  <option value="recent">{$_('logs.recentTime')}</option>
                  <option value="custom">{$_('logs.customTime')}</option>
                </select>
              </div>

              {#if timeRangeType === 'recent'}
                <div class="form-control">
                  <div class="label py-1">
                    <span class="label-text text-xs font-semibold">{$_('logs.recentHours')}</span>
                  </div>
                  <input
                    type="number"
                    bind:value={recentHours}
                    min="1"
                    class="input input-bordered input-sm"
                  />
                </div>
              {/if}

              {#if timeRangeType === 'custom'}
                <div class="form-control">
                  <div class="label py-1">
                    <span class="label-text text-xs font-semibold">{$_('logs.startTime')}</span>
                  </div>
                  <input
                    type="datetime-local"
                    bind:value={customStartTime}
                    class="input input-bordered input-sm"
                  />
                </div>

                <div class="form-control">
                  <div class="label py-1">
                    <span class="label-text text-xs font-semibold">{$_('logs.endTime')}</span>
                  </div>
                  <input
                    type="datetime-local"
                    bind:value={customEndTime}
                    class="input input-bordered input-sm"
                  />
                </div>
              {/if}

              <!-- Sort -->
              <div class="form-control">
                <div class="label py-1">
                  <span class="label-text text-xs font-semibold">{$_('logs.sortBy')}</span>
                </div>
                <div class="flex gap-2">
                  <select bind:value={sortBy} class="select select-bordered select-sm flex-1">
                    <option value="timestamp">{$_('logs.sortByTimestamp')}</option>
                    <option value="duration">{$_('logs.sortByDuration')}</option>
                    <option value="status">{$_('logs.sortByStatus')}</option>
                  </select>
                  <select bind:value={sortOrder} class="select select-bordered select-sm w-24">
                    <option value="desc">{$_('logs.desc')}</option>
                    <option value="asc">{$_('logs.asc')}</option>
                  </select>
                </div>
              </div>

              <div class="divider my-2"></div>
              <h3 class="font-semibold text-sm">{$_('common.refresh')}</h3>

              <!-- Auto Refresh -->
              <div class="form-control">
                <label class="label cursor-pointer">
                  <span class="label-text">{$_('logs.autoRefresh')}</span>
                  <input
                    type="checkbox"
                    class="toggle toggle-primary toggle-sm"
                    bind:checked={autoRefreshEnabled}
                  />
                </label>
              </div>

              {#if autoRefreshEnabled}
                <div class="form-control">
                  <div class="label py-1">
                    <span class="label-text text-xs font-semibold">{$_('logs.refreshInterval')}</span>
                  </div>
                  <select
                    class="select select-bordered select-sm"
                    bind:value={refreshInterval}
                  >
                    <option value="5s">{$_('logs.refreshEvery5s')}</option>
                    <option value="10s">{$_('logs.refreshEvery10s')}</option>
                    <option value="30s">{$_('logs.refreshEvery30s')}</option>
                    <option value="60s">{$_('logs.refreshEvery60s')}</option>
                  </select>
                </div>
              {/if}

              <!-- Manual Refresh -->
              <button
                type="button"
                class="btn btn-sm btn-primary w-full gap-2"
                on:click={manualRefresh}
                disabled={loading}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  class="h-4 w-4"
                  class:animate-spin={loading}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                  />
                </svg>
                {$_('common.refresh')}
              </button>

              <div class="divider my-2"></div>

              <!-- Export Buttons -->
              <div class="flex gap-2">
                <button
                  type="button"
                  class="btn btn-sm btn-secondary flex-1 gap-2"
                  on:click={() => handleExport('json')}
                >
                  JSON
                </button>
                <button
                  type="button"
                  class="btn btn-sm btn-secondary flex-1 gap-2"
                  on:click={() => handleExport('csv')}
                >
                  CSV
                </button>
              </div>

              <!-- Clear Filters -->
              {#if activeFiltersCount > 0}
                <div class="divider my-2"></div>
                <button
                  type="button"
                  class="btn btn-sm btn-ghost w-full gap-1"
                  on:click={clearAllFilters}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                  {$_('logs.clearFilters')}
                </button>
              {/if}
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Filter Chips 展示区 -->
    {#if activeFiltersCount > 0}
      <div class="flex items-center gap-2 flex-wrap px-1">
        {#if searchTerm.trim()}
          <div class="badge badge-lg gap-2">
            <span class="text-xs opacity-70">{$_('logs.searchTerm')}:</span>
            <span class="font-medium">{searchTerm}</span>
            <button
              type="button"
              class="btn btn-ghost btn-xs p-0 h-4 w-4 min-h-0"
              on:click={() => searchTerm = ''}
            >
              <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        {/if}

        {#if method}
          <div class="badge badge-primary badge-lg gap-2">
            <span class="text-xs opacity-70">{$_('logs.method')}:</span>
            <span class="font-medium">{method}</span>
            <button
              type="button"
              class="btn btn-ghost btn-xs p-0 h-4 w-4 min-h-0"
              on:click={() => method = ''}
            >
              <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        {/if}

        {#if statusFilter}
          <div class="badge badge-primary badge-lg gap-2">
            <span class="text-xs opacity-70">{$_('logs.status')}:</span>
            <span class="font-medium">{statusFilter}</span>
            <button
              type="button"
              class="btn btn-ghost btn-xs p-0 h-4 w-4 min-h-0"
              on:click={() => statusFilter = ''}
            >
              <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        {/if}

        {#if successFilter !== undefined}
          <div class="badge badge-primary badge-lg gap-2">
            <span class="text-xs opacity-70">{$_('logs.result')}:</span>
            <span class="font-medium">{successFilter ? $_('logs.success') : $_('logs.failed')}</span>
            <button
              type="button"
              class="btn btn-ghost btn-xs p-0 h-4 w-4 min-h-0"
              on:click={() => successFilter = undefined}
            >
              <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        {/if}

        {#if requestTypeFilter}
          <div class="badge badge-primary badge-lg gap-2">
            <span class="text-xs opacity-70">{$_('logs.requestType')}:</span>
            <span class="font-medium">{$_(`logs.requestType_${requestTypeFilter}`)}</span>
            <button
              type="button"
              class="btn btn-ghost btn-xs p-0 h-4 w-4 min-h-0"
              on:click={() => requestTypeFilter = ''}
            >
              <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        {/if}

        {#if timeRangeType === 'recent' && recentHours !== 1}
          <div class="badge badge-primary badge-lg gap-2">
            <span class="text-xs opacity-70">{$_('logs.timeRange')}:</span>
            <span class="font-medium">{$_('logs.recentTime')} {recentHours}h</span>
            <button
              type="button"
              class="btn btn-ghost btn-xs p-0 h-4 w-4 min-h-0"
              on:click={() => recentHours = 1}
            >
              <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        {/if}

        {#if timeRangeType === 'custom'}
          <div class="badge badge-primary badge-lg gap-2">
            <span class="text-xs opacity-70">{$_('logs.timeRange')}:</span>
            <span class="font-medium">{$_('logs.customTime')}</span>
            <button
              type="button"
              class="btn btn-ghost btn-xs p-0 h-4 w-4 min-h-0"
              on:click={() => { timeRangeType = 'recent'; customStartTime = ''; customEndTime = ''; }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        {/if}

        {#if timeRangeType === 'all'}
          <div class="badge badge-primary badge-lg gap-2">
            <span class="text-xs opacity-70">{$_('logs.timeRange')}:</span>
            <span class="font-medium">{$_('logs.allTime')}</span>
            <button
              type="button"
              class="btn btn-ghost btn-xs p-0 h-4 w-4 min-h-0"
              on:click={() => timeRangeType = 'recent'}
            >
              <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        {/if}

        {#if sortBy !== 'timestamp' || sortOrder !== 'desc'}
          <div class="badge badge-primary badge-lg gap-2">
            <span class="text-xs opacity-70">{$_('logs.sortBy')}:</span>
            <span class="font-medium">{$_(`logs.sortBy${sortBy.charAt(0).toUpperCase() + sortBy.slice(1)}`)} {sortOrder === 'asc' ? '↑' : '↓'}</span>
            <button
              type="button"
              class="btn btn-ghost btn-xs p-0 h-4 w-4 min-h-0"
              on:click={() => { sortBy = 'timestamp'; sortOrder = 'desc'; }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        {/if}
      </div>
    {/if}
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
                <th>{$_('logs.requestType')}</th>
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
                  <td>
                    <span class="badge badge-sm {getRequestTypeColor(log.requestType)}" title={$_(`logs.requestType_${log.requestType}_desc`)}>
                      {getRequestTypeLabel(log.requestType)}
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
