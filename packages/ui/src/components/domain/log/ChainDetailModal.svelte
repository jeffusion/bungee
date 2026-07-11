<script lang="ts">
  import { onMount } from 'svelte';
  import { _ } from '$i18n';
  import type { ChainEntry, LogEntry } from '$api/logs';
  import { getChainDetail } from '$api/logs';
  import LogDetailContent from './LogDetailContent.svelte';
  import { LoadingIndicator } from '$components/industrial';

  export let chain: ChainEntry;
  export let onClose: () => void;

  let chainDetail: { chain: ChainEntry; attempts: LogEntry[] } | null = null;
  let loading = true;
  let error: string | null = null;
  let expandedAttempt: number | null = null;

  function formatTime(ts: number): string {
    return new Date(ts).toLocaleString();
  }

  function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
    return `${(ms / 60000).toFixed(1)}m ${(ms % 60000 / 1000).toFixed(0)}s`;
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

  function handleBackdropClick(event: MouseEvent) {
    if (event.target === event.currentTarget) {
      onClose();
    }
  }

  function toggleAttempt(index: number) {
    expandedAttempt = expandedAttempt === index ? null : index;
  }

  onMount(async () => {
    try {
      chainDetail = await getChainDetail(chain.chainId);
    } catch (e: any) {
      error = e.message;
    } finally {
      loading = false;
    }
  });
</script>

<div
  class="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
  role="presentation"
  on:click={handleBackdropClick}
  on:keydown={(e) => e.key === 'Escape' && onClose()}
>
  <div class="nx-panel-raised nx-bracketed relative w-full max-w-6xl h-[90vh] flex flex-col p-0" role="dialog" aria-labelledby="chain-modal-title" aria-modal="true" data-testid="chain-detail-modal">
    <span class="nx-corner nx-corner-tl" aria-hidden="true"></span>
    <span class="nx-corner nx-corner-tr" aria-hidden="true"></span>
    <span class="nx-corner nx-corner-bl" aria-hidden="true"></span>
    <span class="nx-corner nx-corner-br" aria-hidden="true"></span>

    <div class="flex items-center justify-between px-6 py-3 border-b border-carbon-600 bg-carbon-900">
      <h3 id="chain-modal-title" class="flex items-center gap-2.5 font-mono text-sm font-bold uppercase tracking-command text-zinc-100">
        <span class="nx-stripe" aria-hidden="true"></span>
        {$_('logs.chain.detailTitle')}
      </h3>
      <button class="inline-flex items-center justify-center h-7 w-7 border-2 border-carbon-500 hover:border-nexus-500 hover:text-nexus-300 transition-colors" on:click={onClose} aria-label={$_('common.close')}>
        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>

    <div class="flex-1 overflow-y-auto px-6 py-4 space-y-6">
      {#if loading}
        <div class="flex items-center justify-center py-12">
          <LoadingIndicator label={$_('common.loading')} size="md" centered={true} />
        </div>
      {:else if error}
        <div class="border-l-2 border-l-red-500 bg-red-500/5 px-4 py-3">
          <div class="font-mono text-[11px] uppercase tracking-command text-red-300">{error}</div>
        </div>
      {:else if chainDetail}
        {@const c = chainDetail.chain}
        <div class="nx-panel-sunken p-4">
          <h4 class="mb-3 font-mono text-xs font-bold uppercase tracking-command text-zinc-100">{$_('logs.chain.overview')}</h4>
          <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            <div>
              <div class="text-xs opacity-60 mb-1">{$_('logs.detail.status')}</div>
              <span class={chipClass(getStatusToneClass(c.chainStatus))}>{c.chainStatus}</span>
            </div>
            <div>
              <div class="text-xs opacity-60 mb-1">{$_('logs.detail.method')}</div>
              <span class={chipClass()}>{c.method}</span>
            </div>
            <div>
              <div class="text-xs opacity-60 mb-1">{$_('logs.chain.attemptsCount')}</div>
              <div class="font-semibold font-mono">{c.chainAttempts}</div>
            </div>
            <div>
              <div class="text-xs opacity-60 mb-1">{$_('logs.detail.duration')}</div>
              <div class="font-semibold font-mono">{formatDuration(c.chainDurationMs)}</div>
            </div>
            <div>
              <div class="text-xs opacity-60 mb-1">{$_('logs.detail.timestamp')}</div>
              <div class="text-sm">{formatTime(c.chainStartTs)}</div>
            </div>
            <div class="col-span-2 md:col-span-3 lg:col-span-6">
              <div class="text-xs opacity-60 mb-1">{$_('logs.chain.chainId')}</div>
              <div class="font-mono text-xs break-all">{c.chainId}</div>
            </div>
            <div class="col-span-2 md:col-span-3 lg:col-span-6">
              <div class="text-xs opacity-60 mb-1">{$_('logs.detail.path')}</div>
              <div class="font-mono text-sm bg-carbon-700 p-2 break-all">{c.path}</div>
            </div>
          </div>
        </div>

        <div class="nx-panel-sunken p-4">
          <h4 class="mb-4 font-mono text-xs font-bold uppercase tracking-command text-zinc-100">{$_('logs.chain.timelineTitle')}</h4>
          <div class="space-y-2">
            {#each chainDetail.attempts as attempt, index (attempt.requestId)}
              {@const isExpanded = expandedAttempt === index}
              <div class="border {isExpanded ? 'border-nexus-500/60' : 'border-carbon-600'} bg-carbon-900/60">
                <button
                  type="button"
                  class="w-full flex items-center gap-4 px-4 py-2.5 text-left hover:bg-carbon-700/40 transition-colors"
                  on:click={() => toggleAttempt(index)}
                >
                  <span class="font-mono text-[11px] text-zinc-500 w-8 shrink-0">#{index + 1}</span>
                  <div class="flex items-center gap-1.5 shrink-0">
                    <span class={chipClass(getStatusToneClass(attempt.status))}>{attempt.status}</span>
                  </div>
                  {#if attempt.requestType}
                    <span class={chipClass(getRequestTypeToneClass(attempt.requestType))}>{getRequestTypeLabel(attempt.requestType)}</span>
                  {/if}
                  <span class="font-mono text-[11px] text-zinc-400 flex-1 truncate" title={attempt.attemptUpstream || attempt.upstream || '-'}>
                    {attempt.attemptUpstream || attempt.upstream || '—'}
                  </span>
                  <span class="font-mono text-[11px] text-zinc-300 tabular-nums shrink-0">{formatDuration(attempt.duration)}</span>
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    class="h-3 w-3 text-zinc-500 transition-transform {isExpanded ? 'rotate-180' : ''}"
                    fill="none" viewBox="0 0 24 24" stroke="currentColor"
                  >
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {#if isExpanded}
                  <div class="border-t border-carbon-600 p-4">
                    {#key attempt.requestId}
                      <LogDetailContent log={attempt} showHeader={false} />
                    {/key}
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  </div>
</div>
