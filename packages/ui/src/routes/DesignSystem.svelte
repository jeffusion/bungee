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
    BSegmentedControl,
    BDropdownAction,
  } from '$components/industrial';
  import { Button } from '$components/ui/button';
  import { Input } from '$components/ui/input';
  import { Select } from '$components/ui/select';
  import { Dialog } from '$components/ui/dialog';
  import { DropdownMenu, DropdownMenuItem } from '$components/ui/dropdown-menu';
  import { Badge } from '$components/ui/badge';
  import { Card } from '$components/ui/card';
  import { Label } from '$components/ui/label';
  import { Separator } from '$components/ui/separator';
  import { Textarea } from '$components/ui/textarea';
  import { RadioGroup, RadioGroupItem } from '$components/ui/radio-group';
  import { Switch } from '$components/ui/switch';
  import { Checkbox } from '$components/ui/checkbox';
  import FeatureBadge from '$components/domain/route/FeatureBadge.svelte';
  import HealthSummary from '$components/domain/service/HealthSummary.svelte';
  import RelationshipLink from '$components/domain/service/RelationshipLink.svelte';
  import ConfirmDialog from '$components/shell/ConfirmDialog.svelte';
  import PluginIcon from '$components/shell/PluginIcon.svelte';
  import { toast } from '$stores/toast';

  // Toggle demo state
  let toggleA = true;
  let toggleB = false;
  let toggleC = false;

  // Shadcn Select demo state
  let shadcnSelectValue = '20';
  let shadcnTextareaValue = 'proxy.request.header["x-route"] == "edge"';
  let shadcnRadioValue = 'weighted';
  let shadcnSwitchChecked = true;
  let shadcnCheckboxChecked = true;
  let shadcnCheckboxIndeterminate: boolean | 'indeterminate' = 'indeterminate';
  const shadcnSelectOptions = [
    { value: '10', label: '10', id: 'design-select-option-10' },
    { value: '20', label: '20', id: 'design-select-option-20' },
    { value: '50', label: '50', id: 'design-select-option-50' },
  ];

  // Shadcn Dialog demo state
  let shadcnDialogOpen = false;

  // Shadcn Dropdown demo state
  let shadcnDropdownOpen = false;

  // BSegmentedControl demo state
  let bSegValue = '12h';

  // BDropdownAction demo state
  let bDropdownSelected = '';

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

<div id="page-design" data-testid="page-design" class="px-6 py-6 max-w-6xl mx-auto space-y-8">
  <!-- ===== 1. Overview ================================================= -->
  <header class="space-y-4 pt-2 pb-4 border-b border-carbon-600">
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

    <!-- Layer Legend / How to read this page -->
    <div class="grid grid-cols-1 md:grid-cols-4 gap-3 mt-4 pt-2">
      <div class="border border-carbon-600 bg-carbon-900/40 p-3 space-y-1">
        <div class="font-mono text-[10px] text-nexus-500 uppercase tracking-command">01 // FOUNDATION</div>
        <div class="text-xs text-zinc-200 font-bold">Color & Typography</div>
        <div class="text-[11px] text-zinc-400">Core design tokens, color palettes, and typography scales.</div>
      </div>
      <div class="border border-carbon-600 bg-carbon-900/40 p-3 space-y-1">
        <div class="font-mono text-[10px] text-nexus-500 uppercase tracking-command">02 // BASIC</div>
        <div class="text-xs text-zinc-200 font-bold">Basic Components</div>
        <div class="text-[11px] text-zinc-400">Low-level primitives (shadcn/Bits UI) and utility classes.</div>
      </div>
      <div class="border border-carbon-600 bg-carbon-900/40 p-3 space-y-1">
        <div class="font-mono text-[10px] text-nexus-500 uppercase tracking-command">03 // INDUSTRIAL</div>
        <div class="text-xs text-zinc-200 font-bold">Industrial Components</div>
        <div class="text-[11px] text-zinc-400">Bungee industrial semantic wrappers and telemetry widgets.</div>
      </div>
      <div class="border border-carbon-600 bg-carbon-900/40 p-3 space-y-1">
        <div class="font-mono text-[10px] text-nexus-500 uppercase tracking-command">04 // DOMAIN</div>
        <div class="text-xs text-zinc-200 font-bold">Domain Patterns</div>
        <div class="text-[11px] text-zinc-400">Complex domain-specific components and composite patterns.</div>
      </div>
    </div>
  </header>

  <!-- ===== 2. Color System ============================================= -->
  <section class="space-y-3">
    <SectionDivider label="COLOR SYSTEM" />

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

  <!-- ===== 3. Typography & Spacing ===================================== -->
  <section class="space-y-3">
    <SectionDivider label="TYPOGRAPHY & SPACING" />

    <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
      <PanelCard title="Type Stack" tag="INTER · DM MONO · ORBITRON" class="md:col-span-2">
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

      <PanelCard title="Spacing Scale" tag="GEOMETRY">
        <div class="space-y-2.5">
          <div class="flex items-center gap-3">
            <span class="w-10 font-mono text-[10px] text-zinc-500">4px</span>
            <div class="h-2 bg-nexus-500" style="width: 4px;"></div>
            <span class="font-mono text-[10px] text-zinc-400">space-1</span>
          </div>
          <div class="flex items-center gap-3">
            <span class="w-10 font-mono text-[10px] text-zinc-500">8px</span>
            <div class="h-2 bg-nexus-500" style="width: 8px;"></div>
            <span class="font-mono text-[10px] text-zinc-400">space-2</span>
          </div>
          <div class="flex items-center gap-3">
            <span class="w-10 font-mono text-[10px] text-zinc-500">12px</span>
            <div class="h-2 bg-nexus-500" style="width: 12px;"></div>
            <span class="font-mono text-[10px] text-zinc-400">space-3</span>
          </div>
          <div class="flex items-center gap-3">
            <span class="w-10 font-mono text-[10px] text-zinc-500">16px</span>
            <div class="h-2 bg-nexus-500" style="width: 16px;"></div>
            <span class="font-mono text-[10px] text-zinc-400">space-4</span>
          </div>
          <div class="flex items-center gap-3">
            <span class="w-10 font-mono text-[10px] text-zinc-500">24px</span>
            <div class="h-2 bg-nexus-500" style="width: 24px;"></div>
            <span class="font-mono text-[10px] text-zinc-400">space-6</span>
          </div>
          <div class="flex items-center gap-3">
            <span class="w-10 font-mono text-[10px] text-zinc-500">32px</span>
            <div class="h-2 bg-nexus-500" style="width: 32px;"></div>
            <span class="font-mono text-[10px] text-zinc-400">space-8</span>
          </div>
        </div>
      </PanelCard>
    </div>
  </section>

  <!-- ===== 4. Basic Components ========================================= -->
  <section class="space-y-3" id="design-section-ui-shadcn" data-testid="design-section-ui-shadcn">
    <SectionDivider label="BASIC COMPONENTS" />

    <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
      <!-- Canonical Button Showcase -->
      <PanelCard title="Button" tag="PRIMITIVE">
        <div class="space-y-4">
          <div class="space-y-1.5">
            <span class="nx-label">// SHADCN BUTTONS</span>
            <div class="flex flex-wrap gap-2">
              <Button id="design-button-primary" data-testid="design-button-primary" variant="primary">Primary Button</Button>
              <Button variant="ghost">Ghost Button</Button>
              <Button variant="outline">Outline Button</Button>
              <Button variant="warn">Warn Button</Button>
              <Button variant="danger">Danger Button</Button>
              <Button variant="primary" size="sm">Small</Button>
              <Button variant="primary" disabled>Disabled</Button>
            </div>
          </div>

          <div class="space-y-1.5 border-t border-carbon-600 pt-3">
            <span class="nx-label">// ICON BUTTONS</span>
            <div class="flex flex-wrap gap-2 items-center">
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
          </div>
        </div>
      </PanelCard>

      <!-- Canonical Input Showcase -->
      <PanelCard title="Input & Textarea" tag="PRIMITIVE">
        <div class="space-y-4">
          <div class="space-y-1.5">
            <Label for="design-input-basic">// SHADCN INPUT</Label>
            <Input id="design-input-basic" data-testid="design-input-basic" placeholder="Enter text..." />
          </div>
          <div class="space-y-1.5">
            <Label for="design-textarea-basic">// SHADCN TEXTAREA</Label>
            <Textarea id="design-textarea-basic" bind:value={shadcnTextareaValue} class="font-mono text-xs" />
          </div>
        </div>
      </PanelCard>

      <!-- Canonical Select Showcase -->
      <PanelCard title="Select" tag="PRIMITIVE">
        <div class="space-y-4">
          <div class="space-y-1.5">
            <Label>// SHADCN SELECT</Label>
            <Select
              id="design-select-trigger"
              dataTestid="design-select-trigger"
              options={shadcnSelectOptions}
              bind:value={shadcnSelectValue}
              placeholder="Select option..."
              ariaLabel="shadcn select"
              class="w-[180px]"
            />
          </div>
        </div>
      </PanelCard>

      <PanelCard title="Selection Controls" tag="PRIMITIVE">
        <div class="space-y-5">
          <div class="space-y-2">
            <Label>// SHADCN RADIO GROUP</Label>
            <RadioGroup bind:value={shadcnRadioValue} class="gap-2" aria-label="routing strategy" data-testid="design-radio-group">
              <div class="flex items-center gap-2">
                <RadioGroupItem id="design-radio-weighted" value="weighted" data-testid="design-radio-weighted" />
                <Label for="design-radio-weighted" class="text-zinc-300">Weighted routing</Label>
              </div>
              <div class="flex items-center gap-2">
                <RadioGroupItem id="design-radio-failover" value="failover" data-testid="design-radio-failover" />
                <Label for="design-radio-failover" class="text-zinc-300">Failover routing</Label>
              </div>
            </RadioGroup>
          </div>

          <Separator />

          <div class="flex items-center justify-between gap-4">
            <div class="space-y-1">
              <Label for="design-switch-basic">// SHADCN SWITCH</Label>
              <p class="text-xs text-zinc-400">Binary primitive for compact form rows.</p>
            </div>
            <Switch id="design-switch-basic" data-testid="design-switch-basic" bind:checked={shadcnSwitchChecked} aria-label="enable upstream health checks" />
          </div>

          <Separator />

          <div class="space-y-2">
            <Label>// SHADCN CHECKBOX</Label>
            <div class="flex items-center gap-2">
              <Checkbox id="design-checkbox-basic" data-testid="design-checkbox-basic" bind:checked={shadcnCheckboxChecked} aria-label="enable request logging" />
              <Label for="design-checkbox-basic" class="text-zinc-300">Enable request logging</Label>
            </div>
            <div class="flex items-center gap-2">
              <Checkbox id="design-checkbox-indeterminate" data-testid="design-checkbox-indeterminate" bind:checked={shadcnCheckboxIndeterminate} aria-label="partial route selection" />
              <Label for="design-checkbox-indeterminate" class="text-zinc-300">Partial route selection</Label>
            </div>
          </div>
        </div>
      </PanelCard>

      <PanelCard title="Badge" tag="PRIMITIVE">
        <div class="space-y-4">
          <span class="nx-label">// SHADCN BADGE VARIANTS</span>
          <div class="flex flex-wrap gap-2">
            <Badge>Default</Badge>
            <Badge variant="secondary">Secondary</Badge>
            <Badge variant="destructive">Destructive</Badge>
            <Badge variant="outline">Outline</Badge>
            <Badge variant="ghost">Ghost</Badge>
            <Badge variant="link" href="#/design">Link</Badge>
          </div>
        </div>
      </PanelCard>

      <PanelCard title="Card" tag="PRIMITIVE">
        <Card>
          <Card part="header">
            <Card part="title">Proxy Surface</Card>
            <Card part="description">Composable shadcn-style card primitive.</Card>
          </Card>
          <Card part="content">
            <div class="font-mono text-2xl text-zinc-100">24.8K</div>
            <div class="text-xs text-zinc-500">requests routed in current window</div>
          </Card>
          <Card part="footer">
            <Badge variant="outline">+12.5%</Badge>
            <span class="text-xs text-zinc-500">stable throughput</span>
          </Card>
        </Card>
      </PanelCard>

      <PanelCard title="Label & Separator" tag="PRIMITIVE">
        <div class="space-y-4">
          <div class="space-y-1.5">
            <Label>// FIELD LABEL</Label>
            <p class="text-xs text-zinc-400">Labels provide form metadata without adding business semantics.</p>
          </div>
          <Separator />
          <div class="flex h-12 items-center gap-4 text-xs text-zinc-400">
            <span>LEFT</span>
            <Separator orientation="vertical" />
            <span>RIGHT</span>
          </div>
        </div>
      </PanelCard>

      <!-- Dialog & Dropdown Showcase -->
      <PanelCard title="Dialog & Dropdown" tag="PRIMITIVE">
        <div class="space-y-4">
          <span class="nx-label">// INTERACTIVE TRIGGERS</span>
          <div class="flex flex-wrap gap-2">
            <Button id="design-dialog-trigger" data-testid="design-dialog-trigger" onclick={() => { shadcnDialogOpen = true; }}>
              Open Dialog
            </Button>

            <DropdownMenu bind:open={shadcnDropdownOpen}>
              {#snippet trigger(props)}
                <Button id="design-dropdown-trigger" data-testid="design-dropdown-trigger" {...props}>
                  Open Dropdown
                </Button>
              {/snippet}
              <DropdownMenuItem onclick={() => { toast.show('Item 1 clicked', 'info'); }}>
                Item 1
              </DropdownMenuItem>
              <DropdownMenuItem onclick={() => { toast.show('Item 2 clicked', 'info'); }}>
                Item 2
              </DropdownMenuItem>
            </DropdownMenu>
          </div>
        </div>
      </PanelCard>
    </div>
  </section>

  <Dialog bind:open={shadcnDialogOpen} title="SHADCN DIALOG" description="This is a Svelte 5 shadcn-styled dialog.">
    <div class="space-y-4">
      <p class="text-sm text-zinc-300">
        Industrial-styled dialog with hard edges and carbon background.
      </p>
      <div class="flex justify-end gap-2">
        <Button variant="ghost" onclick={() => shadcnDialogOpen = false}>Cancel</Button>
        <Button variant="primary" onclick={() => { shadcnDialogOpen = false; toast.show('Confirmed', 'success'); }}>Confirm</Button>
      </div>
    </div>
  </Dialog>

  <!-- ===== 5. Industrial Components ==================================== -->
  <section class="space-y-3" id="design-section-industrial-b" data-testid="design-section-industrial-b">
    <SectionDivider label="INDUSTRIAL COMPONENTS" />

    <!-- KPI Cards -->
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

    <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
      <!-- Status & Badges -->
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

      <!-- Panels & Stripes -->
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

      <!-- Metric Bars -->
      <PanelCard title="Resource Allocation" tag="RES-04" class="md:col-span-2">
        <div class="space-y-4">
          <MetricBar label="CPU Cores" value={12} max={16} valueLabel="12/16" tone="neutral" />
          <MetricBar label="Memory Bank" value={32} max={64} valueLabel="32/64" tone="ok" />
          <MetricBar label="Storage" value={19} max={22} valueLabel="19/22" tone="warn" />
          <MetricBar label="GPU Util" value={91} valueLabel="91%" tone="danger" />
          <MetricBar label="Network" value={64} valueLabel="64%" tone="accent" />
        </div>
        <p class="mt-4 font-mono text-[10px] uppercase tracking-command text-zinc-500">// flat normal tones · low-contrast hazard stripes only for warn/danger · auto-threshold available</p>
      </PanelCard>

      <!-- Loading Indicators -->
      <PanelCard title="Data Loading" tag="WAIT" class="md:col-span-3">
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

      <!-- Industrial Controls -->
      <PanelCard title="BSegmentedControl" tag="B-WRAPPER">
        <div class="space-y-3">
          <BSegmentedControl options={segOptions} bind:value={bSegValue} ariaLabel="b-segmented control" />
          <p class="font-mono text-[11px] uppercase tracking-command text-zinc-300">Selected: {bSegValue}</p>
          
          <div class="border-t border-carbon-600 pt-3 space-y-1.5">
            <span class="nx-label">// STANDARD SEGMENTED CONTROL</span>
            <SegmentedControl options={segOptions} bind:value={segValue} ariaLabel="time range" />
            <p class="font-mono text-[11px] uppercase tracking-command text-zinc-300">Selected: {segValue}</p>
          </div>
        </div>
      </PanelCard>

      <PanelCard title="BDropdownAction" tag="B-WRAPPER">
        <div class="space-y-3">
          <BDropdownAction
            items={[
              { label: 'ACTION ALPHA', value: 'alpha' },
              { label: 'ACTION BRAVO', value: 'bravo' },
            ]}
            onselect={(val) => { bDropdownSelected = val; toast.show(`Selected: ${val}`, 'success'); }}
          >
            {#snippet trigger(props)}
              <Button variant="outline" {...props}>
                Trigger Action
              </Button>
            {/snippet}
          </BDropdownAction>
          <p class="font-mono text-[11px] uppercase tracking-command text-zinc-300">Selected: {bDropdownSelected || '(none)'}</p>
        </div>
      </PanelCard>

      <PanelCard title="Industrial Toggle" tag="TOGGLE">
        <p class="text-xs text-zinc-400 mb-3">Hard-edged ON/OFF switch with embedded mono labels. Replaces the legacy round toggle on dark surfaces.</p>
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

      <!-- List Rows -->
      <PanelCard title="List Rows" tag="QUEUE" class="md:col-span-3" flush>
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

      <!-- System Alerts -->
      <div class="space-y-3 md:col-span-3">
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

      <!-- HUD Clock -->
      <PanelCard title="Top-bar Clock" tag="HUD-01" class="md:col-span-3">
        <div class="flex items-center gap-8">
          <HudClock />
          <HudClock tone="zinc" />
        </div>
      </PanelCard>
    </div>
  </section>

  <!-- ===== 6. Domain Patterns ========================================== -->
  <section class="space-y-3">
    <SectionDivider label="DOMAIN PATTERNS" />

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

      <!-- Confirm Dialog -->
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
  confirmClass="nx-btn-danger"
/>
