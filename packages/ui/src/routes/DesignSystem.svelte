<script lang="ts">
  // Industrial Design System Showcase — references all reusable components.
  import {
    PanelCard,
    KpiCard,
    StatusDot,
    StatusBadge,
    SectionDivider,
    MetricBar,
    SegmentedControl,
    HudClock,
    SystemAlertBar,
    IconButton,
    IndustrialToggle,
    LoadingIndicator,
  } from '../lib/components/industrial';
  import FeatureBadge from '../lib/components/FeatureBadge.svelte';
  import HealthSummary from '../lib/components/HealthSummary.svelte';
  import RelationshipLink from '../lib/components/RelationshipLink.svelte';
  import ConfirmDialog from '../lib/components/ConfirmDialog.svelte';
  import PluginIcon from '../lib/components/PluginIcon.svelte';
  import { toast } from '../lib/stores/toast';

  // Toggle demo state
  let toggleA = true;
  let toggleB = false;
  let toggleC = false;

  const PALETTE = [
    { name: 'carbon-950', value: '#0a0b0e', note: 'page bg' },
    { name: 'carbon-900', value: '#15171c', note: 'primary panel' },
    { name: 'carbon-800', value: '#1a1d24', note: 'raised panel' },
    { name: 'carbon-700', value: '#21252e', note: 'hover surface' },
    { name: 'carbon-600', value: '#2a2f3a', note: 'edge / divider' },
    { name: 'carbon-500', value: '#373d4a', note: 'border strong' },
  ];

  const ACCENTS = [
    { name: 'nexus-500', value: '#f97316', note: 'primary accent' },
    { name: 'nexus-400', value: '#fb923c', note: 'hover state' },
    { name: 'nexus-300', value: '#fdba74', note: 'subtle accent' },
    { name: 'hazard-amber', value: '#f59e0b', note: 'warning' },
    { name: 'hazard-red', value: '#ef4444', note: 'danger / alarm' },
    { name: 'hazard-emerald', value: '#10b981', note: 'healthy / OK' },
    { name: 'hazard-sky', value: '#38bdf8', note: 'info / secondary' },
  ];

  const TEXT_TOKENS = [
    { name: 'zinc-50', value: '#fafafa', note: 'display text' },
    { name: 'zinc-100', value: '#f4f4f5', note: 'primary text' },
    { name: 'zinc-300', value: '#d4d4d8', note: 'body text' },
    { name: 'zinc-400', value: '#a1a1aa', note: 'subtle' },
    { name: 'zinc-500', value: '#71717a', note: 'caption / label' },
    { name: 'zinc-600', value: '#52525b', note: 'placeholder' },
  ];

  let segValue = '12h';
  const segOptions = [
    { value: '1h', label: '1H' },
    { value: '12h', label: '12H' },
    { value: '24h', label: '24H' },
  ];

  let loadValue = 67;
  let healthValue = 92;

  // Confirm dialog demo state
  let confirmOpen = false;
  function showConfirm() { confirmOpen = true; }

  // Sample feature-badge descriptor (matches RouteFeatureBadgeDescriptor)
  const sampleBadge = { id: 'auth', section: 'policy', label: 'Auth', labelKey: 'routeFeatures.auth' };

  // Sample health aggregates
  const sampleHealthHealthy   = { total: 5, healthy: 5, halfOpen: 0, unhealthy: 0, disabled: 0, state: 'healthy' as const };
  const sampleHealthDegraded  = { total: 5, healthy: 3, halfOpen: 2, unhealthy: 0, disabled: 0, state: 'degraded' as const };
  const sampleHealthFault     = { total: 5, healthy: 2, halfOpen: 0, unhealthy: 3, disabled: 0, state: 'unhealthy' as const };
  const sampleHealthEmpty     = { total: 0, healthy: 0, halfOpen: 0, unhealthy: 0, disabled: 0, state: 'empty' as const };

  function showSuccessToast() { toast.show('Configuration saved', 'success'); }
  function showWarnToast()    { toast.show('Upstream pool degraded', 'warning'); }
  function showErrorToast()   { toast.show('Failed to apply change', 'error'); }
  function showInfoToast()    { toast.show('New version available', 'info'); }
</script>

<div class="px-6 py-6 max-w-6xl mx-auto space-y-8">
  <!-- ===== Header ===================================================== -->
  <header class="space-y-3 pt-2 pb-3">
    <div class="font-mono text-[10px] uppercase tracking-chiseled text-zinc-500">
      DOC // BUNGEE INDUSTRIAL UI
    </div>
    <h1 class="nx-display text-3xl text-zinc-50 tracking-tight">
      Design System
    </h1>
    <p class="text-sm text-zinc-400 max-w-2xl">
      Component reference for the Bungee admin console — dark carbon
      surfaces, a single orange accent, hazard amber/red for cautions,
      and monospaced display numerics.
    </p>
  </header>

  <!-- ===== Palette ==================================================== -->
  <section class="space-y-3">
    <SectionDivider label="PALETTE" />

    <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
      <PanelCard title="Surfaces" tag="CARBON">
        <div class="space-y-2">
          {#each PALETTE as swatch}
            <div class="flex items-center gap-3 border border-carbon-600">
              <span class="h-10 w-12 border-r border-carbon-600" style:background-color={swatch.value}></span>
              <div class="flex-1 px-2">
                <div class="font-mono text-xs text-zinc-200">{swatch.name}</div>
                <div class="font-mono text-[10px] uppercase tracking-command text-zinc-500">{swatch.note}</div>
              </div>
              <span class="px-3 font-mono text-[10px] text-zinc-500">{swatch.value}</span>
            </div>
          {/each}
        </div>
      </PanelCard>

      <PanelCard title="Signals" tag="ACCENT">
        <div class="space-y-2">
          {#each ACCENTS as swatch}
            <div class="flex items-center gap-3 border border-carbon-600">
              <span class="h-10 w-12 border-r border-carbon-600" style:background-color={swatch.value}></span>
              <div class="flex-1 px-2">
                <div class="font-mono text-xs text-zinc-200">{swatch.name}</div>
                <div class="font-mono text-[10px] uppercase tracking-command text-zinc-500">{swatch.note}</div>
              </div>
              <span class="px-3 font-mono text-[10px] text-zinc-500">{swatch.value}</span>
            </div>
          {/each}
        </div>
      </PanelCard>

      <PanelCard title="Text" tag="ZINC">
        <div class="space-y-2">
          {#each TEXT_TOKENS as swatch}
            <div class="flex items-center gap-3 border border-carbon-600">
              <span class="h-10 w-12 border-r border-carbon-600" style:background-color={swatch.value}></span>
              <div class="flex-1 px-2">
                <div class="font-mono text-xs text-zinc-200">{swatch.name}</div>
                <div class="font-mono text-[10px] uppercase tracking-command text-zinc-500">{swatch.note}</div>
              </div>
              <span class="px-3 font-mono text-[10px] text-zinc-500">{swatch.value}</span>
            </div>
          {/each}
        </div>
      </PanelCard>
    </div>
  </section>

  <!-- ===== Typography ================================================= -->
  <section class="space-y-3">
    <SectionDivider label="TYPOGRAPHY" />

    <PanelCard title="Type Stack" tag="INTER · DM MONO · ORBITRON">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div class="space-y-3">
          <div>
            <span class="nx-label">DISPLAY 4XL</span>
            <p class="nx-display text-4xl text-zinc-50">99.9%</p>
          </div>
          <div>
            <span class="nx-label">DISPLAY 2XL</span>
            <p class="nx-display text-2xl text-nexus-500">42.0 MS</p>
          </div>
          <div>
            <span class="nx-label">HEADLINE</span>
            <p class="font-mono text-sm font-bold uppercase tracking-command text-zinc-100">REQUEST PIPELINE</p>
          </div>
        </div>
        <div class="space-y-3">
          <div>
            <span class="nx-label">BODY</span>
            <p class="text-sm text-zinc-300">Bungee 是一个支持插件扩展的反向代理与 LLM 路由器。</p>
          </div>
          <div>
            <span class="nx-label">CAPTION</span>
            <p class="font-mono text-[11px] uppercase tracking-command text-zinc-500">2026.05.21 17:24:18</p>
          </div>
          <div>
            <span class="nx-label">MONO ID</span>
            <p class="font-mono text-xs text-nexus-300 tracking-[0.14em]">REQ-7F2A-9C44</p>
          </div>
        </div>
      </div>
    </PanelCard>
  </section>

  <!-- ===== KpiCard ==================================================== -->
  <section class="space-y-3">
    <SectionDivider label="KPI CARDS" />

    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      <KpiCard label="UPTIME" value="99.9" unit="%" trend={-0.1}>
        <svg slot="icon-head" viewBox="0 0 24 24" class="h-3.5 w-3.5 text-zinc-500" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </KpiCard>
      <KpiCard label="NETWORK" value="4.2" unit="TB/S" trend={1.2}>
        <svg slot="icon-head" viewBox="0 0 24 24" class="h-3.5 w-3.5 text-zinc-500" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z M3 12h18" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </KpiCard>
      <KpiCard label="THREADS" value="8,902" tone="accent">
        <svg slot="icon-head" viewBox="0 0 24 24" class="h-3.5 w-3.5 text-zinc-500" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /></svg>
      </KpiCard>
      <KpiCard label="ALERTS" value="3" unit="ACT" tone="warn" stripe="amber">
        <svg slot="icon-head" viewBox="0 0 24 24" class="h-3.5 w-3.5 text-amber-400" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
      </KpiCard>
    </div>
  </section>

  <!-- ===== Buttons ==================================================== -->
  <section class="space-y-3">
    <SectionDivider label="BUTTONS" />

    <PanelCard title="Action Surfaces" tag="HARDWARE-KEY">
      <div class="flex flex-wrap gap-3 items-center">
        <button class="nx-btn-primary">
          <svg viewBox="0 0 24 24" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="2.4"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" /></svg>
          Save Config
        </button>
        <button class="nx-btn-ghost">Inspect</button>
        <button class="nx-btn-outline">View Schedule</button>
        <button class="nx-btn-warn">Reload</button>
        <button class="nx-btn-danger">
          <svg viewBox="0 0 24 24" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="2.4"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3" /></svg>
          Delete Route
        </button>
<button class="nx-btn-primary nx-btn-sm">SM</button>
<button class="nx-btn-ghost nx-btn-sm">SM</button>
<button class="nx-btn-primary nx-btn-md">MD</button>
<button class="nx-btn-ghost nx-btn-md">MD</button>
<button class="nx-btn-primary" disabled>Disabled</button>

        <span class="h-6 w-px bg-carbon-600 mx-2"></span>

        <IconButton title="Edit">
          <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
        </IconButton>
        <IconButton variant="primary" title="Run">
          <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
        </IconButton>
        <IconButton variant="danger" title="Stop">
          <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="6" width="12" height="12" /></svg>
        </IconButton>
      </div>
    </PanelCard>
  </section>

  <!-- ===== Status ===================================================== -->
  <section class="space-y-3">
    <SectionDivider label="STATUS & BADGES" />

    <PanelCard title="Status Signals" tag="PILL · DOT">
      <div class="space-y-4">
        <div class="flex flex-wrap items-center gap-2">
          <span class="nx-pill-active"><span class="nx-dot-ok"></span> ACTIVE</span>
          <span class="nx-pill-standby"><span class="nx-dot-warn"></span> STANDBY</span>
          <span class="nx-pill-accent"><span class="nx-dot-accent"></span> SYNC</span>
          <StatusBadge variant="online" dot>ONLINE</StatusBadge>
          <StatusBadge variant="active" dot>HEALTHY</StatusBadge>
          <StatusBadge variant="standby" dot>DEGRADED</StatusBadge>
          <StatusBadge variant="fault" dot>FAULT</StatusBadge>
          <StatusBadge variant="info" dot>INFO</StatusBadge>
          <StatusBadge variant="muted">IDLE</StatusBadge>
        </div>
        <div class="flex flex-wrap items-center gap-4 border-t border-carbon-600 pt-3">
          <span class="flex items-center gap-2 font-mono text-[10px] uppercase tracking-command text-emerald-300"><StatusDot status="ok" /> OK</span>
          <span class="flex items-center gap-2 font-mono text-[10px] uppercase tracking-command text-amber-300"><StatusDot status="warn" /> WARN</span>
          <span class="flex items-center gap-2 font-mono text-[10px] uppercase tracking-command text-red-300"><StatusDot status="danger" /> DANGER</span>
          <span class="flex items-center gap-2 font-mono text-[10px] uppercase tracking-command text-nexus-300"><StatusDot status="accent" /> ACCENT</span>
          <span class="flex items-center gap-2 font-mono text-[10px] uppercase tracking-command text-zinc-500"><StatusDot status="idle" /> IDLE</span>
        </div>
      </div>
    </PanelCard>
  </section>

  <!-- ===== Panels & Stripes ============================================ -->
  <section class="space-y-3">
    <SectionDivider label="PANELS" />

    <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
      <PanelCard title="Standard Panel" tag="PNL-01">
        <p class="text-sm text-zinc-400">A hard-edged container with orange stripe + uppercase title and a right-side tag.</p>
        <div class="mt-3"><span class="nx-metric">128</span></div>
      </PanelCard>

      <PanelCard title="Caution Panel" tag="P2" stripe="amber">
        <p class="text-sm text-amber-200/90">Amber stripe marks a panel that needs attention but is not failing.</p>
      </PanelCard>

      <PanelCard title="Alarm Panel" tag="P1" stripe="red">
        <p class="text-sm text-red-200/90">Red stripes for fault state. Reserve for outages and unhealthy endpoints.</p>
        <div class="mt-3">
          <button class="nx-btn-danger nx-btn-sm">ACK</button>
        </div>
      </PanelCard>
    </div>
  </section>

  <!-- ===== MetricBar =================================================== -->
  <section class="space-y-3">
    <SectionDivider label="METRIC BAR" />

  <PanelCard title="Resource Allocation" tag="RES-04">
    <div class="space-y-4">
      <MetricBar label="CPU Cores" value={12} max={16} valueLabel="12/16" tone="neutral" />
      <MetricBar label="Memory Bank" value={32} max={64} valueLabel="32/64" tone="ok" />
      <MetricBar label="Storage" value={19} max={22} valueLabel="19/22" tone="warn" />
      <MetricBar label="GPU Util" value={91} valueLabel="91%" tone="danger" />
      <MetricBar label="Network" value={64} valueLabel="64%" tone="accent" />
    </div>
    <p class="mt-4 font-mono text-[10px] uppercase tracking-command text-zinc-500">// flat normal tones · low-contrast hazard stripes only for warn/danger · auto-threshold available</p>
  </PanelCard>

    <PanelCard title="Data Loading" tag="WAIT">
      <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div class="border border-carbon-600 bg-carbon-950/60">
          <LoadingIndicator label="LOADING ROUTE INVENTORY" size="lg" height="sm" />
          <div class="border-t border-carbon-600 px-3 py-2">
            <span class="nx-label-sm">// PAGE / EMPTY STATE</span>
          </div>
        </div>
        <div class="border border-carbon-600 bg-carbon-950/60">
          <LoadingIndicator label="SYNCING PANEL" size="md" height="sm" />
          <div class="border-t border-carbon-600 px-3 py-2">
            <span class="nx-label-sm">// PANEL WAIT</span>
          </div>
        </div>
        <div class="flex flex-col justify-center gap-3 border border-carbon-600 bg-carbon-950/60 p-4 text-nexus-300">
          <LoadingIndicator label="SYNCING" size="sm" centered={false} />
          <LoadingIndicator label="FETCHING LOG BODY" size="xs" centered={false} />
          <span class="nx-label-sm text-zinc-500">// INLINE STATUS</span>
        </div>
        <div class="flex flex-col justify-center gap-3 border border-carbon-600 bg-carbon-950/60 p-4">
          <button class="nx-btn-primary nx-btn-sm" disabled>
            <LoadingIndicator label="" size="xs" centered={false} />
            APPLYING
          </button>
          <button class="nx-btn-outline nx-btn-sm" disabled>
            <LoadingIndicator label="" size="xs" centered={false} />
            RELOADING
          </button>
          <span class="nx-label-sm">// BUTTON BUSY</span>
        </div>
      </div>
      <p class="mt-4 font-mono text-[10px] uppercase tracking-command text-zinc-500">// one loading language: breathing dots for buttons | scaled hardware equalizer for status, panels, pages</p>
    </PanelCard>
  </section>

  <!-- ===== Forms ====================================================== -->
  <section class="space-y-3">
    <SectionDivider label="FORMS" />

    <PanelCard title="Inputs" tag="FLAT">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <label class="space-y-1.5 block">
          <span class="nx-label">// ENDPOINT URL</span>
          <input class="nx-input" placeholder="https://upstream.example.com" />
        </label>
        <label class="space-y-1.5 block">
          <span class="nx-label">// AUTH TOKEN</span>
          <input class="nx-input" type="password" placeholder="••••••••••" />
        </label>
        <label class="space-y-1.5 block">
          <span class="nx-label">// PRIORITY</span>
          <select class="nx-input">
            <option>10</option>
            <option>20</option>
            <option>30</option>
          </select>
        </label>
        <div class="space-y-1.5">
          <span class="nx-label">// RANGE</span>
          <SegmentedControl options={segOptions} bind:value={segValue} ariaLabel="time range" />
        </div>
      </div>
    </PanelCard>
  </section>

  <!-- ===== Command Row ================================================ -->
  <section class="space-y-3">
    <SectionDivider label="ROWS" />

    <PanelCard title="List Rows" tag="QUEUE" flush>
      <div>
        <div class="nx-row nx-row-active">
          <div class="flex items-center gap-3">
            <StatusDot status="accent" />
            <span class="font-mono text-[11px] uppercase tracking-command text-nexus-300">/api/chat</span>
            <span class="text-zinc-500 text-xs">→ openai · gemini</span>
          </div>
          <StatusBadge variant="online">ROUTING</StatusBadge>
        </div>
        <div class="nx-row">
          <div class="flex items-center gap-3">
            <StatusDot status="ok" />
            <span class="font-mono text-[11px] uppercase tracking-command text-zinc-300">/healthz</span>
            <span class="text-zinc-500 text-xs">→ origin</span>
          </div>
          <StatusBadge variant="active">200</StatusBadge>
        </div>
        <div class="nx-row">
          <div class="flex items-center gap-3">
            <StatusDot status="warn" />
            <span class="font-mono text-[11px] uppercase tracking-command text-zinc-300">/v1/embeddings</span>
            <span class="text-zinc-500 text-xs">→ pool-b</span>
          </div>
          <StatusBadge variant="standby">DEGRADED</StatusBadge>
        </div>
        <div class="nx-row">
          <div class="flex items-center gap-3">
            <StatusDot status="danger" />
            <span class="font-mono text-[11px] uppercase tracking-command text-zinc-300">/legacy/proxy</span>
            <span class="text-zinc-500 text-xs">→ archive</span>
          </div>
          <StatusBadge variant="fault">5xx</StatusBadge>
        </div>
      </div>
    </PanelCard>
  </section>

  <!-- ===== Alert Bar =================================================== -->
  <section class="space-y-3">
    <SectionDivider label="SYSTEM ALERTS" />

    <div class="space-y-3">
      <SystemAlertBar
        title="SYSTEM HEALTHY"
        subtitle="All services nominal · sync 30s"
        tone="success"
      >
        <button slot="action" class="nx-btn-outline">DETAILS</button>
      </SystemAlertBar>

      <SystemAlertBar
        title="SCHEDULED MAINTENANCE"
        subtitle="Scheduled for: 2026.05.21 · 02:00 UTC"
        tone="info"
      >
        <button slot="action" class="nx-btn-outline">VIEW SCHEDULE</button>
      </SystemAlertBar>

      <SystemAlertBar
        title="2 UPSTREAMS DEGRADED"
        subtitle="api.openai.com · circuit half-open · retries 3"
        tone="warn"
      >
        <button slot="action" class="nx-btn-warn">INSPECT</button>
      </SystemAlertBar>
    </div>
  </section>

  <!-- ===== HUD Clock =================================================== -->
  <section class="space-y-3">
    <SectionDivider label="HUD CLOCK" />

    <PanelCard title="Top-bar Clock" tag="HUD-01">
      <div class="flex items-center gap-8">
        <HudClock />
        <HudClock tone="zinc" />
      </div>
    </PanelCard>
  </section>

  <!-- ===== Domain Components ============================================ -->
  <section class="space-y-3">
    <SectionDivider label="DOMAIN COMPONENTS" />

    <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
      <!-- FeatureBadge -->
      <PanelCard title="Feature Badge" tag="ROUTES">
        <p class="text-xs text-zinc-400 mb-3">Capability tag for routes — single zinc-to-orange palette, clickable.</p>
        <div class="flex flex-wrap gap-1.5">
          <FeatureBadge badge={{ id: 'auth',           section: 'policy',     label: 'Auth',           labelKey: 'routeFeatures.auth' }} />
          <FeatureBadge badge={{ id: 'cors',           section: 'policy',     label: 'CORS',           labelKey: 'routeFeatures.cors' }} />
          <FeatureBadge badge={{ id: 'rate-limit',     section: 'policy',     label: 'Rate Limit',     labelKey: 'routeFeatures.rateLimit' }} />
          <FeatureBadge badge={{ id: 'retry',          section: 'processing', label: 'Retry',          labelKey: 'routeFeatures.retry' }} />
          <FeatureBadge badge={{ id: 'direct-response',section: 'response',   label: 'Direct Resp',    labelKey: 'routeFeatures.directResponse' }} />
          <FeatureBadge badge={{ id: 'plugins',        section: 'plugins',    label: 'Plugins',        labelKey: 'routeFeatures.plugins' }} />
          <FeatureBadge badge={{ id: 'modification',   section: 'processing', label: 'Modification',   labelKey: 'routeFeatures.modification' }} />
        </div>
      </PanelCard>

      <!-- HealthSummary -->
      <PanelCard title="Health Summary" tag="STATUS">
        <p class="text-xs text-zinc-400 mb-3">Status dot + canonical uppercase label.</p>
        <div class="space-y-2 font-mono">
          <HealthSummary aggregate={sampleHealthHealthy} />
          <HealthSummary aggregate={sampleHealthDegraded} />
          <HealthSummary aggregate={sampleHealthFault} />
          <HealthSummary aggregate={sampleHealthEmpty} />
        </div>
      </PanelCard>

      <!-- RelationshipLink -->
      <PanelCard title="Relationship Link" tag="LINK">
        <p class="text-xs text-zinc-400 mb-3">Mono link to a related editor; red icon when broken.</p>
        <div class="flex flex-col gap-2 items-start">
          <RelationshipLink type="route" name="/v1/chat/completions" />
          <RelationshipLink type="service" name="openai-pool" />
          <RelationshipLink type="service" name="missing-pool" isBroken />
        </div>
      </PanelCard>

      <!-- Toast -->
      <PanelCard title="Toast Notifications" tag="ALERT">
        <p class="text-xs text-zinc-400 mb-3">Floating top-right notifications, 4 tones. Click to fire.</p>
        <div class="flex flex-wrap gap-2">
          <button class="nx-btn-ghost nx-btn-sm" on:click={showSuccessToast}>+ SUCCESS</button>
          <button class="nx-btn-warn  nx-btn-sm" on:click={showWarnToast}>+ WARN</button>
          <button class="nx-btn-danger nx-btn-sm" on:click={showErrorToast}>+ ERROR</button>
          <button class="nx-btn-primary nx-btn-sm" on:click={showInfoToast}>+ INFO</button>
        </div>
      </PanelCard>

      <!-- IndustrialToggle -->
      <PanelCard title="Industrial Toggle" tag="TOGGLE">
        <p class="text-xs text-zinc-400 mb-3">Hard-edged ON/OFF switch with embedded mono labels. Replaces daisyUI's round `toggle` on dark surfaces.</p>
        <div class="flex flex-col gap-3">
          <label class="flex items-center gap-3">
            <IndustrialToggle bind:checked={toggleA} title="default on" />
            <span class="font-mono text-[11px] uppercase tracking-command text-zinc-300">Default ON ({toggleA ? 'ON' : 'OFF'})</span>
          </label>
          <label class="flex items-center gap-3">
            <IndustrialToggle bind:checked={toggleB} title="default off" />
            <span class="font-mono text-[11px] uppercase tracking-command text-zinc-300">Default OFF ({toggleB ? 'ON' : 'OFF'})</span>
          </label>
          <label class="flex items-center gap-3">
            <IndustrialToggle bind:checked={toggleC} disabled title="disabled" />
            <span class="font-mono text-[11px] uppercase tracking-command text-zinc-500">Disabled</span>
          </label>
        </div>
      </PanelCard>

      <!-- PluginIcon -->
      <PanelCard title="Plugin Icon" tag="LIGATURE">
        <p class="text-xs text-zinc-400 mb-3">Maps plugin manifest icon ligatures (transform/shield/swap_horiz/…) to inline Lucide-style SVG. Unknown names fall back to a first-letter glyph.</p>
        <div class="grid grid-cols-4 gap-3">
          {#each ['transform','shield','swap_horiz','compare_arrows','wrench','bar_chart','text_rotation_none','settings','bolt','plug','unknown_icon','no_match'] as iconName}
            <div class="flex flex-col items-center gap-1.5">
              <span class="flex h-10 w-10 items-center justify-center border border-carbon-500 bg-carbon-950 text-nexus-400">
                <PluginIcon icon={iconName} fallback={iconName} />
              </span>
              <span class="font-mono text-[9px] uppercase tracking-chiseled text-zinc-500 text-center break-all">{iconName}</span>
            </div>
          {/each}
        </div>
      </PanelCard>

      <!-- ConfirmDialog -->
      <PanelCard title="Confirm Dialog" tag="MODAL" class="md:col-span-2">
        <p class="text-xs text-zinc-400 mb-3">Industrial modal — Esc / backdrop / cancel all dismiss; confirm class auto-maps to industrial buttons.</p>
        <div class="flex gap-2">
          <button class="nx-btn-danger" on:click={showConfirm}>OPEN DESTRUCTIVE</button>
        </div>
      </PanelCard>
    </div>
  </section>
</div>

<ConfirmDialog
  bind:open={confirmOpen}
  title="DELETE ROUTE"
  message="This action is irreversible. The route and any references will be removed."
  confirmText="DELETE"
  cancelText="CANCEL"
  confirmClass="btn-error"
/>
