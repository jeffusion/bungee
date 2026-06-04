<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { _ } from '$i18n';
  import { queryLogs, exportLogs, type LogEntry, type LogQueryParams } from '$api/logs';
  import LogDetailModal from '$components/domain/log/LogDetailModal.svelte';
  import { IndustrialToggle, LoadingIndicator, PanelCard, BDropdownAction } from '$components/industrial';
  import { Select } from '$components/ui/select';
  import { toast } from '$stores/toast';

  // ---- Select option arrays (i18n-safe, constructed in reactive blocks) ----
import { isLoading } from 'svelte-i18n';

$: methodOptions = $isLoading ? [] : [
  { value: '', label: $_('logs.allMethods') },
  { value: 'GET', label: 'GET' },
  { value: 'POST', label: 'POST' },
  { value: 'PUT', label: 'PUT' },
  { value: 'DELETE', label: 'DELETE' },
  { value: 'PATCH', label: 'PATCH' },
];

$: successOptions = $isLoading ? [] : [
  { value: '__all', label: $_('logs.allResults') },
  { value: '__success', label: $_('logs.success') },
  { value: '__failed', label: $_('logs.failed') },
];

$: methodQuickFilterItems = $isLoading ? [] : [
  { value: '', label: $_('logs.allMethods') },
  { value: 'GET', label: 'GET' },
  { value: 'POST', label: 'POST' },
  { value: 'PUT', label: 'PUT' },
  { value: 'DELETE', label: 'DELETE' },
  { value: 'PATCH', label: 'PATCH' },
];

$: resultQuickFilterItems = $isLoading ? [] : [
  { value: '__all', label: $_('logs.allResults') },
  { value: '__success', label: $_('logs.success') },
  { value: '__failed', label: $_('logs.failed') },
];

const exportItems = [
  { value: 'json', label: 'JSON' },
  { value: 'csv', label: 'CSV' },
];

// successFilter is boolean|undefined; Select uses string values, so we bridge
$: successSelectValue = successFilter === true ? '__success' : successFilter === false ? '__failed' : '__all';
function onSuccessSelectChange(val: string) {
  if (val === '__success') successFilter = true;
  else if (val === '__failed') successFilter = false;
  else successFilter = undefined;
}

function onResultQuickFilterSelect(value: string) {
  if (value === '__success') successFilter = true;
  else if (value === '__failed') successFilter = false;
  else successFilter = undefined;
}

function onExportSelect(format: string) {
  if (format === 'json' || format === 'csv') {
    handleExport(format);
  }
}

$: requestTypeOptions = $isLoading ? [] : [
  { value: '', label: $_('logs.requestType_all') },
  { value: 'final', label: $_('logs.requestType_final') },
  { value: 'retry', label: $_('logs.requestType_retry') },
  { value: 'recovery', label: $_('logs.requestType_recovery') },
];

$: timeRangeOptions = $isLoading ? [] : [
  { value: 'all', label: $_('logs.allTime') },
  { value: 'recent', label: $_('logs.recentTime') },
  { value: 'custom', label: $_('logs.customTime') },
];

$: sortByOptions = $isLoading ? [] : [
  { value: 'timestamp', label: $_('logs.sortByTimestamp') },
  { value: 'duration', label: $_('logs.sortByDuration') },
  { value: 'status', label: $_('logs.sortByStatus') },
];

$: sortOrderOptions = $isLoading ? [] : [
  { value: 'desc', label: $_('logs.desc') },
  { value: 'asc', label: $_('logs.asc') },
];

$: refreshIntervalOptions = $isLoading ? [] : [
  { value: '5s', label: $_('logs.refreshEvery5s') },
  { value: '10s', label: $_('logs.refreshEvery10s') },
  { value: '30s', label: $_('logs.refreshEvery30s') },
  { value: '60s', label: $_('logs.refreshEvery60s') },
];

// ---- Industrial status colour helpers --------------------------------
  function getStatusDotClass(status: number): string {
    if (status < 300) return 'nx-dot-ok';
    if (status < 400) return 'nx-dot-accent';
    if (status < 500) return 'nx-dot-warn';
    return 'nx-dot-danger';
  }
  function getStatusTextClass(status: number): string {
    if (status < 300) return 'text-emerald-300';
    if (status < 400) return 'text-nexus-300';
    if (status < 500) return 'text-amber-300';
    return 'text-red-300';
  }
  function getRequestTypeTextClass(requestType?: string): string {
    if (requestType === 'final') return 'text-emerald-300';
    if (requestType === 'retry') return 'text-amber-300';
    if (requestType === 'recovery') return 'text-nexus-300';
    return 'text-zinc-500';
  }

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
      toast.show(`Export failed: ${e.message}`, 'error');
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

<div class="px-6 py-5 space-y-5" data-testid="page-logs">
  <!-- ===== Header ============================================ -->
  <div class="flex items-center gap-3">
    <span class="nx-stripe" aria-hidden="true"></span>
    <div class="flex flex-col leading-tight">
      <span class="nx-label">// REQUEST LOGS</span>
      <h1 class="nx-display text-xl text-zinc-50 tracking-[0.02em]">{$_('logs.title')}</h1>
    </div>
  </div>

  <!-- New data hint -->
  {#if showRefreshHint}
    <div class="border-l-2 border-l-nexus-500 bg-nexus-500/5 px-3 py-2 flex items-center justify-between gap-3">
      <div class="flex items-center gap-2">
        <span class="nx-dot-accent"></span>
        <span class="font-mono text-[11px] uppercase tracking-command text-nexus-200">{$_('logs.newDataAvailable')}</span>
      </div>
      <button class="nx-btn-ghost nx-btn-md" on:click={manualRefresh}>
        {$_('common.refresh')}
      </button>
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
          class="nx-input w-full"
          data-testid="logs-filter-path-input"
        />
      </div>

      <!-- 宽屏布局（≥1280px）：所有控件展开 -->
      <div class="hidden xl:flex items-center gap-2 flex-wrap flex-1">
        <!-- 左侧：过滤按钮组 -->
        <div class="flex items-center gap-2 flex-wrap">
          <!-- Method 下拉 -->
          <div data-testid="logs-filter-method-select">
            <BDropdownAction items={methodQuickFilterItems} onselect={(val) => method = val}>
              {#snippet trigger(props)}
                <div {...props} class={`${method ? 'nx-btn-primary' : 'nx-btn-ghost'} nx-btn-md`}>
                {$_('logs.method')}
                {#if method}
                  <span class="nx-feature-tag">1</span>
                {/if}
                <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                </svg>
                </div>
              {/snippet}
            </BDropdownAction>
          </div>

          <!-- Status 下拉 -->
          <BDropdownAction width="w-48" align="end">
            {#snippet trigger(props)}
              <button type="button" {...props} class={`${statusFilter ? 'nx-btn-primary' : 'nx-btn-ghost'} nx-btn-md`}>              {$_('logs.status')}
              {#if statusFilter}
                <span class="nx-feature-tag">1</span>
              {/if}
              <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
              </svg>
            
              </button>
            {/snippet}
            <div class="p-3">              <div class="space-y-1">
                <div class="label py-1">
                  <span class="nx-label-sm text-xs">{$_('logs.statusPlaceholder')}</span>
                </div>
                <input
                  type="text"
                  bind:value={statusFilter}
                  placeholder="200, 404, 500"
                  class="nx-input"
                />
              </div>
            
            </div>
          </BDropdownAction>

          <!-- Result 下拉 -->
          <BDropdownAction items={resultQuickFilterItems} onselect={onResultQuickFilterSelect}>
            {#snippet trigger(props)}
              <div {...props} class={`${successFilter !== undefined ? 'nx-btn-primary' : 'nx-btn-ghost'} nx-btn-md`}>
              {$_('logs.result')}
              {#if successFilter !== undefined}
                <span class="nx-feature-tag">1</span>
              {/if}
              <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
              </svg>
              </div>
            {/snippet}
          </BDropdownAction>

          <!-- More Filters 下拉 -->
        <BDropdownAction width="w-80" align="end">
            {#snippet trigger(props)}
              <button type="button" {...props} class={`${requestTypeFilter || timeRangeType !== 'recent' || recentHours !== 1 || sortBy !== 'timestamp' || sortOrder !== 'desc' ? 'nx-btn-primary' : 'nx-btn-ghost'} nx-btn-md`}>            {$_('logs.moreFilters')}
            {#if requestTypeFilter || timeRangeType !== 'recent' || recentHours !== 1 || sortBy !== 'timestamp' || sortOrder !== 'desc'}
              <span class="nx-feature-tag">
                {[requestTypeFilter, timeRangeType !== 'recent' || recentHours !== 1, sortBy !== 'timestamp' || sortOrder !== 'desc'].filter(Boolean).length}
              </span>
            {/if}
            <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
            </svg>
          
              </button>
            {/snippet}
            <div class="p-3">            <div class="space-y-3">
              <!-- 请求类型 -->
              <div class="space-y-1">
                <div class="label py-1">
                  <span class="nx-label-sm text-xs font-semibold">{$_('logs.requestTypeFilter')}</span>
                </div>
                <Select options={requestTypeOptions} bind:value={requestTypeFilter} placeholder={$_('logs.requestType_all')} ariaLabel={$_('logs.requestTypeFilter')} />
              </div>

              <!-- 时间范围 -->
              <div class="space-y-1">
                <div class="label py-1">
                  <span class="nx-label-sm text-xs font-semibold">{$_('logs.timeRange')}</span>
                </div>
                <Select options={timeRangeOptions} bind:value={timeRangeType} placeholder={$_('logs.allTime')} ariaLabel={$_('logs.timeRange')} />
              </div>

              <!-- 最近时间（小时） -->
              {#if timeRangeType === 'recent'}
                <div class="space-y-1">
                  <div class="label py-1">
                    <span class="nx-label-sm text-xs font-semibold">{$_('logs.recentHours')}</span>
                  </div>
                  <input
                    type="number"
                    bind:value={recentHours}
                    min="1"
                    class="nx-input"
                  />
                </div>
              {/if}

              <!-- 自定义时间范围 -->
              {#if timeRangeType === 'custom'}
                <div class="space-y-1">
                  <div class="label py-1">
                    <span class="nx-label-sm text-xs font-semibold">{$_('logs.startTime')}</span>
                  </div>
                  <input
                    type="datetime-local"
                    bind:value={customStartTime}
                    class="nx-input"
                  />
                </div>

                <div class="space-y-1">
                  <div class="label py-1">
                    <span class="nx-label-sm text-xs font-semibold">{$_('logs.endTime')}</span>
                  </div>
                  <input
                    type="datetime-local"
                    bind:value={customEndTime}
                    class="nx-input"
                  />
                </div>
              {/if}

              <!-- 排序 -->
              <div class="border-t border-carbon-600 my-2"></div>
              <div class="space-y-1">
                <div class="label py-1">
                  <span class="nx-label-sm text-xs font-semibold">{$_('logs.sortBy')}</span>
                </div>
                <div class="flex flex-wrap gap-2">
                  <Select options={sortByOptions} bind:value={sortBy} placeholder={$_('logs.sortByTimestamp')} ariaLabel={$_('logs.sortBy')} class="flex-1" />
                  <Select options={sortOrderOptions} bind:value={sortOrder} placeholder={$_('logs.desc')} ariaLabel={$_('logs.sortBy')} width="w-24 min-w-[6rem]" />
                </div>
              </div>
            </div>
          
            </div>
          </BDropdownAction>
        </div>

        <!-- 弹性空间 -->
        <div class="flex-1"></div>

        <!-- 右侧：刷新和操作按钮组 -->
        <div class="flex items-center gap-2 flex-wrap">
          <!-- 刷新设置下拉菜单 -->
          <BDropdownAction width="w-64" align="end">
            {#snippet trigger(props)}
              <button type="button" {...props} class="nx-btn-outline nx-btn-md">              <svg
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
                <span class="nx-pill-accent">{refreshInterval}</span>
              {/if}
            
              </button>
            {/snippet}
            <div class="p-3">              <div class="space-y-3">
                <!-- Auto Refresh Toggle -->
                <div class="space-y-1">
                  <label class="label cursor-pointer">
                    <span class="nx-label-sm">{$_('logs.autoRefresh')}</span>
                    <IndustrialToggle bind:checked={autoRefreshEnabled} title={$_('logs.autoRefresh')} />
                  </label>
                </div>

                <!-- Refresh Interval -->
                {#if autoRefreshEnabled}
                  <div class="space-y-1">
                    <div class="label py-1">
                      <span class="nx-label-sm text-xs font-semibold">{$_('logs.refreshInterval')}</span>
                    </div>
                    <Select options={refreshIntervalOptions} bind:value={refreshInterval} placeholder="30s" ariaLabel={$_('logs.refreshInterval')} />
                  </div>
                {/if}
              </div>
            
            </div>
          </BDropdownAction>

          <!-- 手动刷新按钮 -->
          <button
            type="button"
            class="nx-btn-outline nx-btn-md"
            on:click={manualRefresh}
            disabled={loading}
          >
            {#if loading}
              <LoadingIndicator label="" size="xs" centered={false} />
            {:else}
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
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
            {/if}
            <span>{$_('common.refresh')}</span>
          </button>

          <!-- 导出按钮 -->
          <BDropdownAction items={exportItems} width="w-32" onselect={onExportSelect}>
            {#snippet trigger(props)}
              <div {...props} class="nx-btn-ghost nx-btn-md">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              <span>{$_('logs.export')}</span>
              </div>
            {/snippet}
          </BDropdownAction>

          <!-- Clear All 按钮 -->
          {#if activeFiltersCount > 0}
            <button
              type="button"
              class="nx-btn-ghost nx-btn-md"
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
        <BDropdownAction width="w-80" align="end">
            {#snippet trigger(props)}
              <button type="button" {...props} class={`${method || statusFilter || successFilter !== undefined || requestTypeFilter || timeRangeType !== 'recent' || recentHours !== 1 || sortBy !== 'timestamp' || sortOrder !== 'desc' ? 'nx-btn-primary' : 'nx-btn-ghost'} nx-btn-md`}>            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
            </svg>
            {$_('logs.filters')}
            {#if method || statusFilter || successFilter !== undefined || requestTypeFilter || timeRangeType !== 'recent' || recentHours !== 1 || sortBy !== 'timestamp' || sortOrder !== 'desc'}
              <span class="nx-feature-tag">
                {[method, statusFilter, successFilter !== undefined, requestTypeFilter, timeRangeType !== 'recent' || recentHours !== 1, sortBy !== 'timestamp' || sortOrder !== 'desc'].filter(Boolean).length}
              </span>
            {/if}
          
              </button>
            {/snippet}
            <div class="p-3">            <div class="space-y-3">
              <!-- Method -->
              <div class="space-y-1">
                <div class="label py-1">
                  <span class="nx-label-sm text-xs font-semibold">{$_('logs.method')}</span>
                </div>
                <Select options={methodOptions} bind:value={method} placeholder={$_('logs.allMethods')} ariaLabel={$_('logs.method')} />
              </div>

              <!-- Status -->
              <div class="space-y-1">
                <div class="label py-1">
                  <span class="nx-label-sm text-xs font-semibold">{$_('logs.status')}</span>
                </div>
                <input
                  type="text"
                  bind:value={statusFilter}
                  placeholder="200, 404, 500"
                  class="nx-input"
                />
              </div>

              <!-- Result -->
              <div class="space-y-1">
                <div class="label py-1">
                  <span class="nx-label-sm text-xs font-semibold">{$_('logs.result')}</span>
                </div>
                <Select options={successOptions} value={successSelectValue} onchange={onSuccessSelectChange} placeholder={$_('logs.allResults')} ariaLabel={$_('logs.result')} />
              </div>

              <div class="border-t border-carbon-600 my-2"></div>

              <!-- Request Type -->
              <div class="space-y-1">
                <div class="label py-1">
                  <span class="nx-label-sm text-xs font-semibold">{$_('logs.requestTypeFilter')}</span>
                </div>
                <Select options={requestTypeOptions} bind:value={requestTypeFilter} placeholder={$_('logs.requestType_all')} ariaLabel={$_('logs.requestTypeFilter')} />
              </div>

              <!-- Time Range -->
              <div class="space-y-1">
                <div class="label py-1">
                  <span class="nx-label-sm text-xs font-semibold">{$_('logs.timeRange')}</span>
                </div>
                <Select options={timeRangeOptions} bind:value={timeRangeType} placeholder={$_('logs.allTime')} ariaLabel={$_('logs.timeRange')} />
              </div>

              {#if timeRangeType === 'recent'}
                <div class="space-y-1">
                  <div class="label py-1">
                    <span class="nx-label-sm text-xs font-semibold">{$_('logs.recentHours')}</span>
                  </div>
                  <input
                    type="number"
                    bind:value={recentHours}
                    min="1"
                    class="nx-input"
                  />
                </div>
              {/if}

              {#if timeRangeType === 'custom'}
                <div class="space-y-1">
                  <div class="label py-1">
                    <span class="nx-label-sm text-xs font-semibold">{$_('logs.startTime')}</span>
                  </div>
                  <input
                    type="datetime-local"
                    bind:value={customStartTime}
                    class="nx-input"
                  />
                </div>

                <div class="space-y-1">
                  <div class="label py-1">
                    <span class="nx-label-sm text-xs font-semibold">{$_('logs.endTime')}</span>
                  </div>
                  <input
                    type="datetime-local"
                    bind:value={customEndTime}
                    class="nx-input"
                  />
                </div>
              {/if}

              <!-- Sort -->
              <div class="border-t border-carbon-600 my-2"></div>
              <div class="space-y-1">
                <div class="label py-1">
                  <span class="nx-label-sm text-xs font-semibold">{$_('logs.sortBy')}</span>
                </div>
                <div class="flex flex-wrap gap-2">
                  <Select options={sortByOptions} bind:value={sortBy} placeholder={$_('logs.sortByTimestamp')} ariaLabel={$_('logs.sortBy')} class="flex-1" />
                  <Select options={sortOrderOptions} bind:value={sortOrder} placeholder={$_('logs.desc')} ariaLabel={$_('logs.sortBy')} width="w-24 min-w-[6rem]" />
                </div>
              </div>
            </div>
          
            </div>
          </BDropdownAction>

        <!-- 刷新菜单（合并刷新控制） -->
        <BDropdownAction width="w-72" align="end">
            {#snippet trigger(props)}
              <button type="button" {...props} class="nx-btn-ghost nx-btn-md">            {#if loading}
              <LoadingIndicator label="" size="xs" centered={false} />
            {:else}
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
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
            {/if}
            {$_('common.refresh')}
          
              </button>
            {/snippet}
            <div class="p-3">            <div class="space-y-3">
              <!-- Auto Refresh Toggle -->
              <div class="space-y-1">
                <label class="label cursor-pointer">
                  <span class="nx-label-sm">{$_('logs.autoRefresh')}</span>
                  <IndustrialToggle bind:checked={autoRefreshEnabled} title={$_('logs.autoRefresh')} />
                </label>
              </div>

              <!-- Refresh Interval -->
              {#if autoRefreshEnabled}
                <div class="space-y-1">
                  <div class="label py-1">
                    <span class="nx-label-sm text-xs font-semibold">{$_('logs.refreshInterval')}</span>
                  </div>
                  <Select options={refreshIntervalOptions} bind:value={refreshInterval} placeholder="30s" ariaLabel={$_('logs.refreshInterval')} />
                </div>
              {/if}

              <!-- Manual Refresh Button -->
              <div class="border-t border-carbon-600 my-2"></div>
              <button
                type="button"
                class="nx-btn-primary nx-btn-md w-full"
                on:click={manualRefresh}
                disabled={loading}
              >
                {#if loading}
                  <LoadingIndicator label="" size="xs" centered={false} />
                {:else}
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
                      d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                    />
                  </svg>
                {/if}
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
          </BDropdownAction>

        <!-- 导出按钮 -->
        <BDropdownAction items={exportItems} width="w-32" onselect={onExportSelect}>
          {#snippet trigger(props)}
            <div {...props} class="nx-btn-ghost nx-btn-md">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            {$_('logs.export')}
            </div>
          {/snippet}
        </BDropdownAction>

        <!-- Clear All 按钮 -->
        {#if activeFiltersCount > 0}
          <button
            type="button"
            class="nx-btn-ghost nx-btn-md"
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
        <BDropdownAction width="w-80" align="end">
            {#snippet trigger(props)}
              <button type="button" {...props} class="nx-btn-ghost nx-btn-md">            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
            {$_('logs.actions')}
            {#if method || statusFilter || successFilter !== undefined || requestTypeFilter || timeRangeType !== 'recent' || recentHours !== 1 || sortBy !== 'timestamp' || sortOrder !== 'desc' || autoRefreshEnabled}
              <span class="nx-pill-accent"></span>
            {/if}
          
              </button>
            {/snippet}
            <div class="p-3">            <div class="space-y-3">
              <h3 class="font-semibold text-sm">{$_('logs.filters')}</h3>

              <!-- Method -->
              <div class="space-y-1">
                <div class="label py-1">
                  <span class="nx-label-sm text-xs font-semibold">{$_('logs.method')}</span>
                </div>
                <Select options={methodOptions} bind:value={method} placeholder={$_('logs.allMethods')} ariaLabel={$_('logs.method')} />
              </div>

              <!-- Status -->
              <div class="space-y-1">
                <div class="label py-1">
                  <span class="nx-label-sm text-xs font-semibold">{$_('logs.status')}</span>
                </div>
                <input
                  type="text"
                  bind:value={statusFilter}
                  placeholder="200, 404, 500"
                  class="nx-input"
                />
              </div>

              <!-- Result -->
              <div class="space-y-1">
                <div class="label py-1">
                  <span class="nx-label-sm text-xs font-semibold">{$_('logs.result')}</span>
                </div>
                <Select options={successOptions} value={successSelectValue} onchange={onSuccessSelectChange} placeholder={$_('logs.allResults')} ariaLabel={$_('logs.result')} />
              </div>

              <!-- Request Type -->
              <div class="space-y-1">
                <div class="label py-1">
                  <span class="nx-label-sm text-xs font-semibold">{$_('logs.requestTypeFilter')}</span>
                </div>
                <Select options={requestTypeOptions} bind:value={requestTypeFilter} placeholder={$_('logs.requestType_all')} ariaLabel={$_('logs.requestTypeFilter')} />
              </div>

              <!-- Time Range -->
              <div class="space-y-1">
                <div class="label py-1">
                  <span class="nx-label-sm text-xs font-semibold">{$_('logs.timeRange')}</span>
                </div>
                <Select options={timeRangeOptions} bind:value={timeRangeType} placeholder={$_('logs.allTime')} ariaLabel={$_('logs.timeRange')} />
              </div>

              {#if timeRangeType === 'recent'}
                <div class="space-y-1">
                  <div class="label py-1">
                    <span class="nx-label-sm text-xs font-semibold">{$_('logs.recentHours')}</span>
                  </div>
                  <input
                    type="number"
                    bind:value={recentHours}
                    min="1"
                    class="nx-input"
                  />
                </div>
              {/if}

              {#if timeRangeType === 'custom'}
                <div class="space-y-1">
                  <div class="label py-1">
                    <span class="nx-label-sm text-xs font-semibold">{$_('logs.startTime')}</span>
                  </div>
                  <input
                    type="datetime-local"
                    bind:value={customStartTime}
                    class="nx-input"
                  />
                </div>

                <div class="space-y-1">
                  <div class="label py-1">
                    <span class="nx-label-sm text-xs font-semibold">{$_('logs.endTime')}</span>
                  </div>
                  <input
                    type="datetime-local"
                    bind:value={customEndTime}
                    class="nx-input"
                  />
                </div>
              {/if}

              <!-- Sort -->
              <div class="space-y-1">
                <div class="label py-1">
                  <span class="nx-label-sm text-xs font-semibold">{$_('logs.sortBy')}</span>
                </div>
                <div class="flex flex-wrap gap-2">
                  <Select options={sortByOptions} bind:value={sortBy} placeholder={$_('logs.sortByTimestamp')} ariaLabel={$_('logs.sortBy')} class="flex-1" />
                  <Select options={sortOrderOptions} bind:value={sortOrder} placeholder={$_('logs.desc')} ariaLabel={$_('logs.sortBy')} width="w-24 min-w-[6rem]" />
                </div>
              </div>

              <div class="border-t border-carbon-600 my-2"></div>
              <h3 class="font-semibold text-sm">{$_('common.refresh')}</h3>

              <!-- Auto Refresh -->
              <div class="space-y-1">
                <label class="label cursor-pointer">
                  <span class="nx-label-sm">{$_('logs.autoRefresh')}</span>
                  <IndustrialToggle bind:checked={autoRefreshEnabled} title={$_('logs.autoRefresh')} />
                </label>
              </div>

              {#if autoRefreshEnabled}
                <div class="space-y-1">
                  <div class="label py-1">
                    <span class="nx-label-sm text-xs font-semibold">{$_('logs.refreshInterval')}</span>
                  </div>
                  <Select options={refreshIntervalOptions} bind:value={refreshInterval} placeholder="30s" ariaLabel={$_('logs.refreshInterval')} />
                </div>
              {/if}

              <!-- Manual Refresh -->
              <button
                type="button"
                class="nx-btn-primary nx-btn-md w-full"
                on:click={manualRefresh}
                disabled={loading}
              >
                {#if loading}
                  <LoadingIndicator label="" size="xs" centered={false} />
                {:else}
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
                      d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                    />
                  </svg>
                {/if}
                {$_('common.refresh')}
              </button>

              <div class="border-t border-carbon-600 my-2"></div>

              <!-- Export Buttons -->
              <div class="flex flex-wrap gap-2">
                <button
                  type="button"
                  class="nx-btn-ghost nx-btn-md flex-1"
                  on:click={() => handleExport('json')}
                >
                  JSON
                </button>
                <button
                  type="button"
                  class="nx-btn-ghost nx-btn-md flex-1"
                  on:click={() => handleExport('csv')}
                >
                  CSV
                </button>
              </div>

              <!-- Clear Filters -->
              {#if activeFiltersCount > 0}
                <div class="border-t border-carbon-600 my-2"></div>
                <button
                  type="button"
                  class="nx-btn-ghost nx-btn-md w-full"
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
          </BDropdownAction>
      </div>
    </div>

    <!-- Filter Chips 展示区 -->
    {#if activeFiltersCount > 0}
      <div class="flex items-center gap-2 flex-wrap px-1">
        {#if searchTerm.trim()}
          <div class="inline-flex items-center gap-1.5 border border-carbon-500 bg-carbon-900 px-2.5 py-0.5 font-mono text-[11px] uppercase tracking-command text-zinc-300">
            <span class="text-xs opacity-70">{$_('logs.searchTerm')}:</span>
            <span class="font-medium">{searchTerm}</span>
            <button
              type="button"
              class="inline-flex items-center justify-center h-4 w-4 text-zinc-500 hover:text-red-300 transition-colors"
              on:click={() => searchTerm = ''}
              aria-label={$_('logs.clearFilters')}
            >
              <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        {/if}

        {#if method}
          <div class="inline-flex items-center gap-1.5 border border-nexus-500/60 bg-nexus-500/10 px-2.5 py-0.5 font-mono text-[11px] uppercase tracking-command text-nexus-300">
            <span class="text-xs opacity-70">{$_('logs.method')}:</span>
            <span class="font-medium">{method}</span>
            <button
              type="button"
              class="inline-flex items-center justify-center h-4 w-4 text-zinc-500 hover:text-red-300 transition-colors"
              on:click={() => method = ''}
              aria-label={$_('logs.clearFilters')}
            >
              <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        {/if}

        {#if statusFilter}
          <div class="inline-flex items-center gap-1.5 border border-nexus-500/60 bg-nexus-500/10 px-2.5 py-0.5 font-mono text-[11px] uppercase tracking-command text-nexus-300">
            <span class="text-xs opacity-70">{$_('logs.status')}:</span>
            <span class="font-medium">{statusFilter}</span>
            <button
              type="button"
              class="inline-flex items-center justify-center h-4 w-4 text-zinc-500 hover:text-red-300 transition-colors"
              on:click={() => statusFilter = ''}
              aria-label={$_('logs.clearFilters')}
            >
              <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        {/if}

        {#if successFilter !== undefined}
          <div class="inline-flex items-center gap-1.5 border border-nexus-500/60 bg-nexus-500/10 px-2.5 py-0.5 font-mono text-[11px] uppercase tracking-command text-nexus-300">
            <span class="text-xs opacity-70">{$_('logs.result')}:</span>
            <span class="font-medium">{successFilter ? $_('logs.success') : $_('logs.failed')}</span>
            <button
              type="button"
              class="inline-flex items-center justify-center h-4 w-4 text-zinc-500 hover:text-red-300 transition-colors"
              on:click={() => successFilter = undefined}
              aria-label={$_('logs.clearFilters')}
            >
              <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        {/if}

        {#if requestTypeFilter}
          <div class="inline-flex items-center gap-1.5 border border-nexus-500/60 bg-nexus-500/10 px-2.5 py-0.5 font-mono text-[11px] uppercase tracking-command text-nexus-300">
            <span class="text-xs opacity-70">{$_('logs.requestType')}:</span>
            <span class="font-medium">{$_(`logs.requestType_${requestTypeFilter}`)}</span>
            <button
              type="button"
              class="inline-flex items-center justify-center h-4 w-4 text-zinc-500 hover:text-red-300 transition-colors"
              on:click={() => requestTypeFilter = ''}
              aria-label={$_('logs.clearFilters')}
            >
              <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        {/if}

        {#if timeRangeType === 'recent' && recentHours !== 1}
          <div class="inline-flex items-center gap-1.5 border border-nexus-500/60 bg-nexus-500/10 px-2.5 py-0.5 font-mono text-[11px] uppercase tracking-command text-nexus-300">
            <span class="text-xs opacity-70">{$_('logs.timeRange')}:</span>
            <span class="font-medium">{$_('logs.recentTime')} {recentHours}h</span>
            <button
              type="button"
              class="inline-flex items-center justify-center h-4 w-4 text-zinc-500 hover:text-red-300 transition-colors"
              on:click={() => recentHours = 1}
              aria-label={$_('logs.clearFilters')}
            >
              <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        {/if}

        {#if timeRangeType === 'custom'}
          <div class="inline-flex items-center gap-1.5 border border-nexus-500/60 bg-nexus-500/10 px-2.5 py-0.5 font-mono text-[11px] uppercase tracking-command text-nexus-300">
            <span class="text-xs opacity-70">{$_('logs.timeRange')}:</span>
            <span class="font-medium">{$_('logs.customTime')}</span>
            <button
              type="button"
              class="inline-flex items-center justify-center h-4 w-4 text-zinc-500 hover:text-red-300 transition-colors"
              on:click={() => { timeRangeType = 'recent'; customStartTime = ''; customEndTime = ''; }}
              aria-label={$_('logs.clearFilters')}
            >
              <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        {/if}

        {#if timeRangeType === 'all'}
          <div class="inline-flex items-center gap-1.5 border border-nexus-500/60 bg-nexus-500/10 px-2.5 py-0.5 font-mono text-[11px] uppercase tracking-command text-nexus-300">
            <span class="text-xs opacity-70">{$_('logs.timeRange')}:</span>
            <span class="font-medium">{$_('logs.allTime')}</span>
            <button
              type="button"
              class="inline-flex items-center justify-center h-4 w-4 text-zinc-500 hover:text-red-300 transition-colors"
              on:click={() => timeRangeType = 'recent'}
              aria-label={$_('logs.clearFilters')}
            >
              <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        {/if}

        {#if sortBy !== 'timestamp' || sortOrder !== 'desc'}
          <div class="inline-flex items-center gap-1.5 border border-nexus-500/60 bg-nexus-500/10 px-2.5 py-0.5 font-mono text-[11px] uppercase tracking-command text-nexus-300">
            <span class="text-xs opacity-70">{$_('logs.sortBy')}:</span>
            <span class="font-medium">{$_(`logs.sortBy${sortBy.charAt(0).toUpperCase() + sortBy.slice(1)}`)} {sortOrder === 'asc' ? '↑' : '↓'}</span>
            <button
              type="button"
              class="inline-flex items-center justify-center h-4 w-4 text-zinc-500 hover:text-red-300 transition-colors"
              on:click={() => { sortBy = 'timestamp'; sortOrder = 'desc'; }}
              aria-label={$_('logs.clearFilters')}
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
    <PanelCard title={$_('logs.title')} tag="LOADING">
      <LoadingIndicator label="LOADING LOG STREAM" height="md" />
    </PanelCard>
  {:else if error}
    <PanelCard title={$_('common.error')} tag="ERR" stripe="red">
      <p class="font-mono text-[11px] uppercase tracking-command text-red-300">{error}</p>
    </PanelCard>
  {:else if logs.length === 0}
    <PanelCard title={$_('logs.noData')} tag="EMPTY" stripe="zinc">
      <div class="py-6 text-center" data-testid="logs-empty-state">
        <span class="font-mono text-[11px] uppercase tracking-command text-zinc-500">
          {$_('logs.noData')}
        </span>
      </div>
    </PanelCard>
  {:else}
    <PanelCard title="REQUEST LOG" tag={`N=${logs.length}/${total}`} flush>
      <div class="overflow-x-auto">
        <table class="w-full">
          <thead class="border-b border-carbon-600 bg-carbon-900/60">
            <tr>
              <th class="text-left nx-label py-2.5 px-4">{$_('logs.time')}</th>
              <th class="text-left nx-label py-2.5 px-4">{$_('logs.method')}</th>
              <th class="text-left nx-label py-2.5 px-4">{$_('logs.path')}</th>
              <th class="text-left nx-label py-2.5 px-4">{$_('logs.status')}</th>
              <th class="text-left nx-label py-2.5 px-4">{$_('logs.requestType')}</th>
              <th class="text-right nx-label py-2.5 px-4">{$_('logs.duration')}</th>
              <th class="text-left nx-label py-2.5 px-4">{$_('logs.upstream')}</th>
              <th class="text-right nx-label py-2.5 px-4">{$_('logs.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {#each logs.slice(0, 1) as firstLog (firstLog.requestId)}
              <tr class="group border-b border-carbon-600/60 hover:bg-carbon-700/40 transition-colors" data-testid="logs-row-first">
                <td class="py-2.5 px-4 font-mono text-[11px] text-zinc-400">{formatTime(firstLog.timestamp)}</td>
                <td class="py-2.5 px-4"><span class="nx-feature-tag">{firstLog.method}</span></td>
                <td class="py-2.5 px-4 font-mono text-[12px] text-zinc-200 truncate max-w-xs" title={firstLog.path}>
                  {firstLog.path}
                </td>
                <td class="py-2.5 px-4">
                  <span class="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-command">
                    <span class={getStatusDotClass(firstLog.status)}></span>
                    <span class={getStatusTextClass(firstLog.status)}>{firstLog.status}</span>
                  </span>
                </td>
                <td class="py-2.5 px-4">
                  <span
                    class="font-mono text-[10px] uppercase tracking-command {getRequestTypeTextClass(firstLog.requestType)}"
                    title={$_(`logs.requestType_${firstLog.requestType}_desc`)}
                  >
                    {getRequestTypeLabel(firstLog.requestType)}
                  </span>
                </td>
                <td class="py-2.5 px-4 text-right font-mono text-[11px] text-zinc-300 tabular-nums">{formatDuration(firstLog.duration)}</td>
                <td class="py-2.5 px-4 font-mono text-[11px] text-zinc-400 truncate max-w-xs" title={firstLog.upstream || '-'}>
                  {firstLog.upstream || '—'}
                </td>
                <td class="py-2.5 px-4 text-right">
                  <button
                    class="nx-btn-ghost nx-btn-sm opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                    on:click={() => viewDetail(firstLog)}
                  >
                    {$_('logs.viewDetail')}
                  </button>
                </td>
              </tr>
            {/each}
            {#each logs.slice(1) as log (log.requestId)}
              <tr class="group border-b border-carbon-600/60 hover:bg-carbon-700/40 transition-colors">
                <td class="py-2.5 px-4 font-mono text-[11px] text-zinc-400">{formatTime(log.timestamp)}</td>
                <td class="py-2.5 px-4"><span class="nx-feature-tag">{log.method}</span></td>
                <td class="py-2.5 px-4 font-mono text-[12px] text-zinc-200 truncate max-w-xs" title={log.path}>
                  {log.path}
                </td>
                <td class="py-2.5 px-4">
                  <span class="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-command">
                    <span class={getStatusDotClass(log.status)}></span>
                    <span class={getStatusTextClass(log.status)}>{log.status}</span>
                  </span>
                </td>
                <td class="py-2.5 px-4">
                  <span
                    class="font-mono text-[10px] uppercase tracking-command {getRequestTypeTextClass(log.requestType)}"
                    title={$_(`logs.requestType_${log.requestType}_desc`)}
                  >
                    {getRequestTypeLabel(log.requestType)}
                  </span>
                </td>
                <td class="py-2.5 px-4 text-right font-mono text-[11px] text-zinc-300 tabular-nums">{formatDuration(log.duration)}</td>
                <td class="py-2.5 px-4 font-mono text-[11px] text-zinc-400 truncate max-w-xs" title={log.upstream || '-'}>
                  {log.upstream || '—'}
                </td>
                <td class="py-2.5 px-4 text-right">
                  <button
                    class="nx-btn-ghost nx-btn-sm opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
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

      <!-- Pagination -->
      <div class="flex justify-between items-center px-4 py-3 border-t border-carbon-600 bg-carbon-900/60">
        <span class="font-mono text-[10px] uppercase tracking-command text-zinc-500">
          {$_('logs.showing', { values: { start: (page - 1) * limit + 1, end: Math.min(page * limit, total), total } })}
        </span>
        <div class="inline-flex border border-carbon-500 bg-carbon-900">
          <button
            class="nx-pager-btn"
            disabled={page <= 1}
            on:click={() => (page = page - 1)}
          >«</button>
          <span class="nx-pager-btn pointer-events-none">
            {$_('logs.page', { values: { page, totalPages } })}
          </span>
          <button
            class="nx-pager-btn"
            disabled={page >= totalPages}
            on:click={() => (page = page + 1)}
          >»</button>
        </div>
      </div>
    </PanelCard>
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
