<script lang="ts">
  import { location } from 'svelte-spa-router';
  import { isLoading } from 'svelte-i18n';
  import { _, locale, SUPPORTED_LOCALES, switchLocale } from './lib/i18n';
  import Dashboard from './routes/Dashboard.svelte';
  import Configuration from './routes/Configuration.svelte';
  import RoutesIndex from './routes/RoutesIndex.svelte';
  import RouteEditor from './routes/RouteEditor.svelte';
  import Logs from './routes/Logs.svelte';
  import NotFound from './routes/NotFound.svelte';
  import ToastContainer from './lib/components/ToastContainer.svelte';

  // i18n 已在模块级别初始化，无需在组件中初始化

  // 语言切换下拉菜单
  let dropdownOpen = false;

  function handleLocaleChange(newLocale: string) {
    switchLocale(newLocale);
    dropdownOpen = false;
  }
</script>

{#if $isLoading}
  <!-- i18n 加载中 -->
  <div class="min-h-screen bg-base-200 flex items-center justify-center">
    <div class="flex flex-col items-center gap-4">
      <span class="loading loading-spinner loading-lg"></span>
      <p class="text-base-content/60">Loading...</p>
    </div>
  </div>
{:else}
  <div class="min-h-screen bg-base-200">
  <!-- Header -->
  <div class="navbar bg-base-100 shadow-lg sticky top-0 z-50">
    <div class="flex-1">
      <a href="/__ui/#/" class="flex items-center gap-2 px-4 py-2 hover:bg-base-200 rounded-lg transition-colors">
        <!-- Logo Icon -->
        <svg xmlns="http://www.w3.org/2000/svg" class="h-8 w-8 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
        <!-- Brand -->
        <div class="flex flex-col">
          <span class="text-xl font-bold">Bungee</span>
          <span class="text-xs text-base-content/60">Reverse Proxy</span>
        </div>
      </a>
    </div>

    <!-- Navigation -->
    <div class="flex-none">
      <ul class="menu menu-horizontal px-1 gap-1">
        <li>
          <a
            href="/__ui/#/"
            class:active={$location === '/'}
            class="flex items-center gap-2"
          >
            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
            </svg>
            <span>{$_('nav.dashboard')}</span>
          </a>
        </li>
        <li>
          <a
            href="/__ui/#/routes"
            class:active={$location.startsWith('/routes')}
            class="flex items-center gap-2"
          >
            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
            </svg>
            <span>{$_('nav.routes')}</span>
          </a>
        </li>
        <li>
          <a
            href="/__ui/#/logs"
            class:active={$location === '/logs'}
            class="flex items-center gap-2"
          >
            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <span>{$_('nav.logs')}</span>
          </a>
        </li>
        <li>
          <a
            href="/__ui/#/config"
            class:active={$location === '/config'}
            class="flex items-center gap-2"
          >
            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            <span>{$_('nav.configuration')}</span>
          </a>
        </li>
      </ul>

      <!-- 语言切换器 -->
      <div class="dropdown dropdown-end mx-2">
        <label tabindex="0" class="btn btn-ghost btn-sm gap-1">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129" />
          </svg>
          <span class="text-xs">
            {SUPPORTED_LOCALES.find(l => l.code === $locale)?.name}
          </span>
        </label>
        <ul tabindex="0" class="dropdown-content z-[1] menu p-2 shadow bg-base-100 rounded-box w-32 mt-2 gap-1">
          {#each SUPPORTED_LOCALES as supportedLocale}
            <li>
              <button
                class:active={$locale === supportedLocale.code}
                on:click={() => handleLocaleChange(supportedLocale.code)}
              >
                {supportedLocale.name}
              </button>
            </li>
          {/each}
        </ul>
      </div>
    </div>
  </div>

  <!-- 手动路由（因为 svelte-spa-router 的 onMount 不工作） -->
  {#if $location === '/'}
    <Dashboard />
  {:else if $location === '/routes'}
    <RoutesIndex />
  {:else if $location.startsWith('/routes/edit/')}
    <RouteEditor params={{ path: $location.replace('/routes/edit/', '') }} />
  {:else if $location === '/routes/new'}
    <RouteEditor params={{}} />
  {:else if $location === '/logs'}
    <Logs />
  {:else if $location === '/config'}
    <Configuration />
  {:else}
    <NotFound />
  {/if}
</div>
{/if}

<!-- Toast 通知容器 -->
<ToastContainer />

<style>
  .active {
    background-color: hsl(var(--p) / 0.2);
  }
</style>
