<script lang="ts">
  import { _ } from '$i18n';
</script>

<div class="min-h-[calc(100vh-4rem)] flex flex-col items-center justify-center px-6 py-12 nx-grid-bg relative">
  <div class="text-center space-y-6 max-w-md">
    <div class="flex justify-center">
      <span class="font-mono text-[10px] uppercase tracking-chiseled text-zinc-500 border border-carbon-600 bg-carbon-900 px-3 py-1">
        ERR — 404 / ROUTE NOT FOUND
      </span>
    </div>

    <h1 class="nx-display text-7xl text-nexus-500 tracking-tight">
      404
    </h1>

    <h2 class="font-mono text-base font-bold uppercase tracking-command text-zinc-200">
      {$_('notFound.title')}
    </h2>

    <p class="font-mono text-sm text-zinc-500 leading-relaxed">
      {$_('notFound.message')}
    </p>

    <div class="pt-2">
      <a href="/__ui/#/" class="nx-btn-primary">
        <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2.4">
          <path stroke-linecap="round" stroke-linejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
        </svg>
        <span>{$_('notFound.goHome')}</span>
      </a>
    </div>
  </div>
</div>
