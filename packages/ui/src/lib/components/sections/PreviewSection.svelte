<script lang="ts">
  import type { Route } from '../../api/routes';
  import { _ } from '../../i18n';

  export let route: Route;

  let showJson = false;

  // 生成用于预览的路由配置（移除前端专用字段）
  $: previewRoute = {
    ...route,
    upstreams: route.upstreams.map(({ _uid, ...upstream }) => upstream)
  };

  $: jsonConfig = JSON.stringify(previewRoute, null, 2);

  // 计算统计信息
  $: stats = {
    upstreamsCount: route.upstreams.length,
    hasAuth: route.auth?.enabled || false,
    hasFailover: route.failover?.enabled || false,
    hasTransformer: (route.plugins && route.plugins.length > 0) || false,
    hasPathRewrite: route.pathRewrite && Object.keys(route.pathRewrite).length > 0,
    totalWeight: route.upstreams.reduce((sum, u) => sum + (u.weight || 100), 0)
  };
</script>

<div class="space-y-6">
  <div>
    <h3 class="text-lg font-semibold">{$_('routeEditor.preview')}</h3>
    <p class="text-sm text-gray-500 mt-1">
      {$_('routeEditor.previewHelp')}
    </p>
  </div>

  <!-- 统计信息卡片 -->
  <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
    <div class="stat bg-base-200 rounded-lg">
      <div class="stat-title">{$_('routeEditor.upstreams')}</div>
      <div class="stat-value text-primary">{stats.upstreamsCount}</div>
      <div class="stat-desc">{$_('routeEditor.totalWeight')}: {stats.totalWeight}</div>
    </div>

    <div class="stat bg-base-200 rounded-lg">
      <div class="stat-title">{$_('routeEditor.features')}</div>
      <div class="stat-value text-2xl">
        {[stats.hasAuth, stats.hasFailover, stats.hasTransformer, stats.hasPathRewrite].filter(Boolean).length}
      </div>
      <div class="stat-desc">{$_('routeEditor.featuresEnabled')}</div>
    </div>

    <div class="stat bg-base-200 rounded-lg">
      <div class="stat-title">{$_('routes.path')}</div>
      <div class="stat-value text-sm truncate" title={route.path}>
        {route.path || $_('routeEditor.notSet')}
      </div>
      <div class="stat-desc">{$_('routeEditor.routePath')}</div>
    </div>
  </div>

  <!-- 功能列表 -->
  <div class="card bg-base-200">
    <div class="card-body">
      <h4 class="card-title text-base">{$_('routeEditor.enabledFeatures')}</h4>
      <div class="space-y-2">
        <div class="flex items-center gap-2">
          <div class={`badge ${stats.hasAuth ? 'badge-success' : 'badge-ghost'}`}>
            {stats.hasAuth ? '✓' : '○'}
          </div>
          <span class="text-sm">{$_('auth.routeAuth')}</span>
        </div>
        <div class="flex items-center gap-2">
          <div class={`badge ${stats.hasFailover ? 'badge-success' : 'badge-ghost'}`}>
            {stats.hasFailover ? '✓' : '○'}
          </div>
          <span class="text-sm">{$_('routeEditor.failoverTitle')}</span>
        </div>
        <div class="flex items-center gap-2">
          <div class={`badge ${stats.hasTransformer ? 'badge-success' : 'badge-ghost'}`}>
            {stats.hasTransformer ? '✓' : '○'}
          </div>
          <span class="text-sm">{$_('routeEditor.transformer')}</span>
        </div>
        <div class="flex items-center gap-2">
          <div class={`badge ${stats.hasPathRewrite ? 'badge-success' : 'badge-ghost'}`}>
            {stats.hasPathRewrite ? '✓' : '○'}
          </div>
          <span class="text-sm">{$_('routeEditor.pathRewrite')}</span>
        </div>
      </div>
    </div>
  </div>

  <!-- Upstreams 列表 -->
  <div class="card bg-base-200">
    <div class="card-body">
      <h4 class="card-title text-base">{$_('routeEditor.upstreams')}</h4>
      <div class="space-y-2">
        {#each route.upstreams as upstream, index}
          <div class="flex items-center gap-3 p-3 bg-base-100 rounded-lg">
            <div class="badge badge-primary">{upstream.priority || index + 1}</div>
            <div class="flex-1">
              <div class="font-medium text-sm truncate" title={upstream.target}>
                {upstream.target || $_('routeEditor.notSet')}
              </div>
              <div class="text-xs text-gray-500">
                {$_('upstream.weight')}: {upstream.weight || 100}
                {#if upstream.plugins && upstream.plugins.length > 0}
                  <span class="badge badge-xs badge-info ml-2">Transformer</span>
                {/if}
              </div>
            </div>
          </div>
        {/each}
      </div>
    </div>
  </div>

  <!-- JSON 配置预览 -->
  <div class="card bg-base-200">
    <div class="card-body">
      <div class="flex justify-between items-center">
        <h4 class="card-title text-base">{$_('routeEditor.jsonConfig')}</h4>
        <button
          type="button"
          class="btn btn-sm btn-ghost"
          on:click={() => showJson = !showJson}
        >
          {showJson ? $_('common.hide') : $_('common.show')}
        </button>
      </div>

      {#if showJson}
        <div class="mockup-code mt-4">
          <pre><code>{jsonConfig}</code></pre>
        </div>
        <div class="card-actions justify-end mt-4">
          <button
            type="button"
            class="btn btn-sm btn-outline"
            on:click={() => {
              navigator.clipboard.writeText(jsonConfig);
              alert($_('common.copied'));
            }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            {$_('common.copy')}
          </button>
        </div>
      {/if}
    </div>
  </div>

  <!-- 请求流程图 -->
  <div class="card bg-base-200">
    <div class="card-body">
      <h4 class="card-title text-base">{$_('routeEditor.requestFlow')}</h4>
      <div class="flex flex-col gap-3 mt-4">
        <!-- 客户端请求 -->
        <div class="flex items-center gap-3">
          <div class="badge badge-lg badge-neutral">1</div>
          <div class="flex-1">
            <div class="font-medium">{$_('routeEditor.clientRequest')}</div>
            <div class="text-xs text-gray-500">{route.path || '/'}</div>
          </div>
        </div>

        <div class="ml-6 border-l-2 border-base-300 pl-4 space-y-3">
          <!-- 认证检查 -->
          {#if stats.hasAuth}
            <div class="flex items-center gap-3">
              <div class="badge badge-sm badge-success">✓</div>
              <div class="text-sm">{$_('auth.routeAuth')}</div>
            </div>
          {/if}

          <!-- Path Rewrite -->
          {#if stats.hasPathRewrite}
            <div class="flex items-center gap-3">
              <div class="badge badge-sm badge-info">→</div>
              <div class="text-sm">{$_('routeEditor.pathRewrite')}</div>
            </div>
          {/if}

          <!-- 路由级转换 -->
          {#if stats.hasTransformer}
            <div class="flex items-center gap-3">
              <div class="badge badge-sm badge-warning">⚡</div>
              <div class="text-sm">{$_('routeEditor.transformer')}</div>
            </div>
          {/if}

          <!-- Upstreams -->
          <div class="flex items-center gap-3">
            <div class="badge badge-lg badge-primary">2</div>
            <div class="flex-1">
              <div class="font-medium">{$_('routeEditor.selectUpstream')}</div>
              <div class="text-xs text-gray-500">
                {stats.upstreamsCount} {$_('routeEditor.upstreams')}
                {#if stats.hasFailover}
                  <span class="badge badge-xs badge-success ml-1">{$_('routeEditor.failoverEnabled')}</span>
                {/if}
              </div>
            </div>
          </div>

          <!-- 响应 -->
          <div class="flex items-center gap-3">
            <div class="badge badge-lg badge-accent">3</div>
            <div class="font-medium">{$_('routeEditor.returnResponse')}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
