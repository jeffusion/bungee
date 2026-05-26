# Bungee Industrial Design System

> **Status:** authoritative · **Audience:** anyone (human or AI) touching
> `packages/ui/`, plugin native widgets, or any HTML that ships under
> `/__ui/*`.  
> **Mantra:** dark carbon surfaces · single orange accent · hard edges ·
> monospaced numerics · zero gloss.

This document is the **single source of truth** for the Bungee UI visual
language. When a design or implementation question arises and this file
contradicts a design tool or an old screenshot — this file wins. Update
this file *first*, then update code.

---

## 1. Why this exists

The Bungee dashboard is operational software. Operators stare at it
during incidents. The visual language should feel like **a piece of
industrial control equipment**: durable, legible, deliberate, with
information density traded only against scannability — never against
ornament.

Three properties we optimise for:

1. **Confidence.** Status colours map to a single canonical meaning
   (orange = primary action / focus; emerald = healthy; amber = warning;
   red = fault). Operators learn the mapping once.
2. **Legibility under load.** Numerics are mono-spaced and bold display
   type. Labels are uppercase with letterspacing. Type contrast against
   the dark carbon background is high.
3. **Hardware feel.** Hard edges, 2px borders, L-shaped corner
   brackets, hairline dividers, no rounded "card" shadow gloss, no
   glassmorphism.

If a design choice violates *any* of these three, it's wrong.

---

## 2. Tokens

All tokens are defined in
`packages/ui/tailwind.theme.js` and exposed via the **`industrial`**
DaisyUI theme set in `index.html` (`<html data-theme="industrial">`).
Always use the named token, never a hex literal.

### 2.1 Colour palette

| Group       | Token            | Hex       | Role                                    |
|-------------|------------------|-----------|-----------------------------------------|
| **Carbon**  | `carbon-950`     | `#0a0b0e` | Page background (deepest)               |
|             | `carbon-900`     | `#15171c` | Primary panel surface                   |
|             | `carbon-800`     | `#1a1d24` | Raised panel surface                    |
|             | `carbon-700`     | `#21252e` | Hover surface                           |
|             | `carbon-600`     | `#2a2f3a` | Edge / divider (default)                |
|             | `carbon-500`     | `#373d4a` | Edge strong / input border              |
| **Nexus**   | `nexus-500`      | `#f97316` | **Primary accent (orange)**             |
|             | `nexus-400`      | `#fb923c` | Hover state                             |
|             | `nexus-300`      | `#fdba74` | Subtle accent                           |
| **Hazard**  | `emerald-400/500`| `#10b981` | Healthy / OK                            |
|             | `amber-400/500`  | `#f59e0b` | Caution / standby                       |
|             | `red-400/500`    | `#ef4444` | Fault / alarm                           |
|             | `sky-400/500`    | `#38bdf8` | Info / secondary signal                 |
| **Text**    | `zinc-50/100`    | `#f4f4f5` | Primary text / display                  |
|             | `zinc-300`       | `#d4d4d8` | Body text                               |
|             | `zinc-400`       | `#a1a1aa` | Subtle text                             |
|             | `zinc-500`       | `#71717a` | Caption / label                         |
|             | `zinc-600`       | `#52525b` | Placeholder                             |

**Rules:**
- The **primary accent is orange**, full stop. Don't introduce cyan,
  blue, purple, etc. as a second "brand colour".
- Status colours are *only* for status. Don't paint a button red because
  it looks cool; red means failure.
- For chart series prefer `nexus → sky → emerald → amber → red` in that
  order of priority.

### 2.2 Typography

Three families, all loaded via Google Fonts in `index.html`:

| Family        | Use case                                                | Examples                              |
|---------------|---------------------------------------------------------|---------------------------------------|
| **Inter**     | Body text, paragraphs, descriptions                     | "Bungee 是一个反向代理…"                |
| **DM Mono**   | Labels, IDs, status badges, captions, time codes        | `REQ-7F2A`, `// LABEL`, `12:34:56`    |
| **Orbitron**  | Display numerics, headlines, HUD clock                  | `99.9`, `4.2`, `BUNGEE`               |

Apply via Tailwind utilities or convenience classes:

```html
<p class="font-sans text-sm text-zinc-300">Body copy uses Inter.</p>
<p class="font-mono text-[11px] uppercase tracking-command">LABEL TEXT</p>
<p class="nx-display text-3xl text-zinc-50">99.9</p>
<p class="nx-metric">128</p>           <!-- shorthand: Orbitron 3xl -->
<p class="nx-label">// SECTION</p>     <!-- shorthand: DM Mono 10px, uppercase, chiseled tracking, zinc-500 -->
```

**Letterspacing scale** (in `tailwind.theme.js`):

| Class                  | Value     | Use for                       |
|------------------------|-----------|-------------------------------|
| `tracking-industrial`  | `0.08em`  | Headlines                     |
| `tracking-command`     | `0.12em`  | Most labels / nav / buttons   |
| `tracking-chiseled`    | `0.16em`  | Small captions / sub-labels   |
| `tracking-signage`     | `0.24em`  | Banner / hero text            |

### 2.3 Geometry

| Property              | Value           | Notes                                |
|-----------------------|-----------------|--------------------------------------|
| Base font-size        | `14px`          | `html { font-size: 14px }`           |
| Border radius default | `2px`           | Hard edges; never `rounded-lg+`      |
| Panel border          | `1px carbon-600`| Default; orange on hover when `nx-bracketed` |
| Button border         | `2px`           | Hardware-key feel                    |
| Spacing scale         | `6 / 12 / 18 / 24 px` (i.e. `gap-1.5/3/4.5/6`) |  |
| Grid gap              | `12 / 20 / 24 px` typical             |  |
| Animation             | `120–200ms ease-out`                  | Never bouncy / spring |

**Hard rule:** no `rounded-lg`, no `rounded-xl`, no `rounded-full`
(except `nx-dot` which is `rounded-full` for the indicator dot itself).

---

## 3. Component Library

All reusable industrial UI components live in
**`packages/ui/src/lib/components/industrial/`** and are re-exported
from `industrial/index.ts`. Import via the barrel:

```ts
import {
  PanelCard, KpiCard, CornerBrackets,
  StatusDot, StatusBadge,
  SectionDivider, MetricBar,
  SegmentedControl, HudClock,
  SystemAlertBar, IconButton,
  IndustrialToggle, NxSelect,
} from '$lib/components/industrial';

// Domain-level support components live one level up:
import PluginIcon from '$lib/components/PluginIcon.svelte';
import FeatureBadge from '$lib/components/FeatureBadge.svelte';
import HealthSummary from '$lib/components/HealthSummary.svelte';
import RelationshipLink from '$lib/components/RelationshipLink.svelte';
import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
```

For every component the **prop signature, default behaviour, and
required parent context** are documented inline in the `.svelte` file's
top-of-file comment. Read the source — it's the spec.

### 3.1 Quick reference

| Component        | Purpose                                                   | Where you'd use it                                  |
|------------------|-----------------------------------------------------------|-----------------------------------------------------|
| `PanelCard`      | Generic panel: orange stripe + title + right-side tag     | Wraps every chart, list, form group, or section    |
| `KpiCard`        | Single headline metric (label + display number + unit)    | Dashboard KPI strip, summary cards                  |
| `CornerBrackets` | The 4 L-shaped chassis indicators                         | Internal; PanelCard/KpiCard render it by default    |
| `StatusDot`      | Tiny luminous indicator (ok/warn/danger/idle/accent)      | Anywhere status needs a glance                      |
| `StatusBadge`    | Outlined pill (active/standby/online/fault/muted/info)    | Top-right of panel headers, list rows, KPI footers  |
| `SectionDivider` | Two thin rules + `// LABEL` between them                  | Logical region break inside a long page             |
| `MetricBar`      | Horizontal progress bar with label + value + auto-tone    | Load / utilisation / capacity rows                  |
| `SegmentedControl` | Bordered group of equal-weight radio buttons            | Range pickers, mode toggles                         |
| `HudClock`       | Display-style clock for the top bar                       | Top bar only (don't duplicate elsewhere)            |
| `SystemAlertBar` | Full-width attention strip with action                    | Bottom of a page; maintenance notices               |
| `IconButton`     | Square hardware-key button for icon-only actions          | Toolbars; header controls                           |
| `IndustrialToggle` | Flat hard-edged ON/OFF switch with embedded OFF/ON text | Anywhere you'd reach for daisyUI `toggle`. Replaces it everywhere on dark surfaces. |
| `LoadingIndicator` | Industrial async activity indicator with module/compact hierarchy | Page/panel loading, inline status, and button busy states. Replaces circular spinners and daisyUI loaders. |
| `NxSelect` | Custom dropdown select with industrial-themed popup | Replace native `<select>` everywhere; popup matches carbon-900 dark theme. Use in filter panels, forms, toolbars. |

**Domain support components (also industrialized):**

| Component             | Location                              | Purpose                                                       |
|-----------------------|---------------------------------------|---------------------------------------------------------------|
| `FeatureBadge`        | `lib/components/FeatureBadge.svelte`  | Capability chip for routes (auth/cors/etc.); zinc → orange on hover |
| `HealthSummary`       | `lib/components/HealthSummary.svelte` | Status dot + uppercase label (HEALTHY/DEGRADED/FAULT/N/A/EMPTY) |
| `RelationshipLink`    | `lib/components/RelationshipLink.svelte` | Mono link to a related route/service editor; red if broken |
| `ConfirmDialog`       | `lib/components/ConfirmDialog.svelte` | Modal for destructive actions; auto-maps `confirmClass` to industrial buttons |
| `Toast`/`ToastContainer` | `lib/components/Toast.svelte` etc. | Floating top-right notifications with 4 canonical tones      |
| `EndpointQuickPreview`| `lib/components/EndpointQuickPreview.svelte` | Compact preview of a service's first N endpoints       |
| `PluginIcon`          | `lib/components/PluginIcon.svelte`    | Renders a plugin's `metadata.icon` ligature (transform/shield/wrench/...) as an inline Lucide-style SVG. Falls back to first-letter glyph for unknown ligatures. **No external icon font required.** |

**Utility classes (in `app.css`) backing the above:**

- `.nx-feature-tag` / `.nx-feature-tag-interactive` — the FeatureBadge chip
- `.nx-stripe` / `.nx-stripe-amber|red|emerald|zinc` — panel-head accent bar
- `.nx-corner` + `.nx-corner-tl/tr/bl/br` — corner brackets
- `.nx-bracketed` — opt-in hover/focus contract for bracketed panels
- `.nx-toggle` + `.nx-toggle-track` + `.nx-toggle-knob` — hard-edged industrial toggle (see §4.6)
- `.nx-pager-btn` — segmented pagination buttons (see §4.7)

### 3.2 The `nx-bracketed` contract

`PanelCard` and `KpiCard` carry `.nx-bracketed` by default. This class
binds the parent's hover/focus state to its 4 corner brackets so they
brighten + grow, and the panel border shifts to orange. **Don't
re-implement this in ad-hoc panels**; reach for `PanelCard` instead.

Visual contract (set in `app.css`):

| State           | Bracket size | Bracket opacity | Panel border           |
|-----------------|--------------|-----------------|------------------------|
| Default         | 10×10 px     | 0.6             | `carbon-600` (grey)    |
| Hover / focus   | 14×14 px     | 1.0             | `nexus-500` @ 55%      |

Transition: `180ms ease-out`.

#### 3.2.1 When to use corner brackets — Tiered application ⚠️

Corner brackets are a **focus / authority** signal, not decoration.
Apply them only on panels that carry **navigational weight** on the
page. If every panel has brackets, no panel has brackets.

**Decision matrix:**

| Page region                                       | `corners` | Why |
|---------------------------------------------------|-----------|-----|
| KPI strip / top-of-page headline metrics          | `true` (default) | These are the page's primary read; brackets say "look here first" |
| Section-level panels (charts, monitors, single-purpose forms) | `true` (default) | Each owns its viewport region |
| Side-bar / builder navigation                     | `true`     | Anchors the workspace |
| Modal dialogs / drawers                           | `true`     | Modal-level emphasis |
| **Repeating list / grid items** (plugin cards, route rows, log rows, service tiles) | **`false`** | These are *peers*. Bracketing all of them produces a wall of equal-emphasis noise and the page loses hierarchy. |
| Help text / hint panels nested inside another panel | `false`   | Visually subordinate |

**Rule of thumb:** if there are ≥ 4 visually identical panels next to
each other, set `corners={false}` on them. The container or section
header carries the bracketed emphasis instead.

Passing `corners={false}` to `<PanelCard>` removes both the four
`nx-corner` SVG elements *and* the `.nx-bracketed` class (so the
border-orange-on-hover effect goes away too). The orange stripe in the
header **stays** — that's structural identification, not focus.

### 3.3 The orange stripe header pattern

Every panel header carries the **signature orange short stripe** on the
left of the title. `PanelCard` emits it automatically. For ad-hoc panel
heads use the `.nx-panel-head` + `.nx-stripe` combo:

```html
<header class="nx-panel-head">
  <div class="nx-panel-head-title">
    <span class="nx-stripe"></span>
    <span>CHANNEL HEALTH</span>
  </div>
  <span class="nx-panel-head-tag">CH-01</span>
</header>
```

Stripe variants: `nx-stripe`, `nx-stripe-amber`, `nx-stripe-red`,
`nx-stripe-emerald`, `nx-stripe-zinc`. Use status colours only when the
panel itself represents that status state.

---

## 4. CSS utility classes

Defined in `packages/ui/src/app.css` under `@layer components` /
`@layer utilities`. They survive Tailwind purge because the file lists
them explicitly. **Don't reinvent these inline.**

### 4.1 Surfaces & panels

| Class              | Effect                                                    |
|--------------------|-----------------------------------------------------------|
| `nx-panel`         | `border + carbon-800 bg + carbon-600 edge`                |
| `nx-panel-raised`  | `nx-panel` + `shadow-industrial`                          |
| `nx-panel-sunken`  | Slightly darker background, for "inset" sub-panels        |
| `nx-bracketed`     | Marks parent as a "device chassis" responsive to hover    |
| `nx-panel-head`    | Standard panel header bar (border-b + flex)               |
| `nx-panel-head-title` | Title element with mono + tracking + uppercase         |
| `nx-panel-head-tag`| Small right-aligned tag (mono, zinc-500)                  |
| `nx-panel-body`    | Standard body padding                                     |
| `nx-corner`, `nx-corner-tl/tr/bl/br` | 4 L-shaped corner indicators            |

### 4.2 Typography helpers

| Class           | Effect                                                       |
|-----------------|--------------------------------------------------------------|
| `nx-label`      | DM Mono · 10px · uppercase · `tracking-chiseled` · zinc-500  |
| `nx-label-sm`   | Same, 9px                                                    |
| `nx-display`    | Orbitron · bold · `letter-spacing: -0.01em` · `line-height: 1` |
| `nx-metric`     | `nx-display` · `text-3xl` · `text-zinc-50`                   |
| `nx-metric-lg`  | `nx-display` · `text-4xl` · `text-zinc-50`                   |
| `nx-mono`       | DM Mono · tabular-nums                                       |
| `nx-caps`       | uppercase · `tracking-command`                               |

### 4.3 Status

| Class              | Effect                                                    |
|--------------------|-----------------------------------------------------------|
| `nx-dot-ok/warn/danger/idle/accent` | 2×2 dot with optional glow            |
| `nx-badge-active/standby/online/fault/muted/info` | Outlined pill           |
| `nx-pill-active/standby/accent` | Solid pill (top bar / nav)                   |

Prefer the **`<StatusDot>`** / **`<StatusBadge>`** components over
hand-crafted classes when you're using these in Svelte — they keep
ARIA & default props consistent.

### 4.4 Buttons

| Class            | Effect                                                      |
|------------------|-------------------------------------------------------------|
| `nx-btn`         | Base: border-2, uppercase, mono, tracking-command           |
| `nx-btn-primary` | Orange solid, hardware-key                                  |
| `nx-btn-ghost`   | Carbon-edged, becomes orange on hover                       |
| `nx-btn-outline` | Zinc-100 outline (used for the "VIEW SCHEDULE" pattern)     |
| `nx-btn-warn`    | Amber-edged                                                 |
| `nx-btn-danger`  | Red-edged with tinted fill                                  |
| `nx-btn-sm` | Modifier: smaller padding/font (compact, in-panel use) |
| `nx-btn-md` | Modifier: h-9 matching `nx-input` height (toolbar/form-row use) |

### 4.5 Decorative

| Class                                 | Effect                                       |
|---------------------------------------|----------------------------------------------|
| `nx-stripes-orange/amber/red`         | Hazard-stripe background pattern             |
| `nx-grid-bg`, `nx-grid-bg-dense`      | Subtle grid backgrounds (20px / 12px)        |
| `nx-caret-left`                       | Small orange triangle (active-tab indicator) |
| `nx-row`, `nx-row-active`             | Row item with hover + active variant         |
| `nx-input`                            | Flat industrial form input                   |

### 4.6 Toggle switch

`daisyUI`'s round `.toggle` is hard to see on the dark carbon surfaces.
We replace it with a hard-edged industrial switch that carries explicit
`OFF` / `ON` mono-text labels inside the track:

| Class              | Effect                                                    |
|--------------------|-----------------------------------------------------------|
| `nx-toggle`        | The clickable label wrapper                               |
| `nx-toggle-track`  | The 52×24 carbon track; flips to orange when checked      |
| `nx-toggle-knob`   | The 20×20 slider; carbon-500 → near-black when checked    |

```html
<label class="nx-toggle">
  <input type="checkbox" bind:checked={enabled} />
  <span class="nx-toggle-track">
    <span class="nx-toggle-knob"></span>
  </span>
</label>
```

Prefer the **`<IndustrialToggle>`** component for Svelte (handles `change`
event, `disabled`, `title`, and a11y).

### 4.7 Plugin icons (special case)

Plugin manifests declare icons by Material-Icons ligature name
(`transform`, `shield`, `swap_horiz`, …). The project ships **no**
external icon font; render them through **`<PluginIcon>`** which maps
the canonical ligature set to Lucide-style stroke SVGs that match the
industrial palette. Unknown ligatures degrade to a first-letter glyph,
so the slot never goes empty.

```svelte
<PluginIcon icon={plugin.metadata?.icon} fallback={plugin.name} sizeClass="h-5 w-5" />
```

**Don't** load `material-icons` CSS from Google fonts — it conflicts
with the design system's single-orange-accent rule and silently breaks
when offline. Add new icon mappings inside `PluginIcon.svelte`'s
`PLUGIN_ICON_PATHS` table instead.

---

## 5. Page composition recipes

### 5.1 Standard page header

```html
<div class="px-6 py-5 space-y-5">
  <div class="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
    <div class="flex items-center gap-3">
      <span class="nx-stripe" aria-hidden="true"></span>
      <div class="flex flex-col leading-tight">
        <span class="nx-label">// {$_('foo.section')}</span>
        <h1 class="nx-display text-xl text-zinc-50 tracking-[0.02em]">
          {$_('foo.title')}
        </h1>
      </div>
    </div>
    <!-- Right-side controls (SegmentedControl / buttons / search) -->
  </div>
```

### 5.2 KPI strip (5 cards, equal width)

```html
<section class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
  <KpiCard label="..." value="..." unit="..." trend={1.2} />
  <!-- ... -->
</section>
```

### 5.3 Section group (chart / list / form panels)

```html
<div class="grid grid-cols-1 lg:grid-cols-2 gap-3">
  <PanelCard title="REQUESTS TREND" tag="CH-01">
    <div class="h-52"><LineChart .../></div>
  </PanelCard>
  <PanelCard title="ERRORS" tag="CH-04" stripe="red">
    <div class="h-52"><LineChart .../></div>
  </PanelCard>
</div>
```

### 5.4 Logical separator between sections

```html
<SectionDivider label="EXTENSIONS" />
```

### 5.5 Footer attention strip

```html
<SystemAlertBar
  tone="info"
  title="..."
  subtitle="..."
>
  <a slot="action" href="..." class="nx-btn-outline">DETAILS</a>
</SystemAlertBar>
```

### 5.6 List-row inside a panel

```html
<PanelCard title="ACTIVE ROUTES" tag="QUEUE" flush>
  <div>
    <div class="nx-row nx-row-active">
      <div class="flex items-center gap-3">
        <StatusDot status="accent" />
        <span class="font-mono text-[11px] uppercase tracking-command text-nexus-300">/api/chat</span>
      </div>
      <StatusBadge variant="online">ROUTING</StatusBadge>
    </div>
    <div class="nx-row">…</div>
  </div>
</PanelCard>
```

---

## 6. Hard rules — do this, not that

### 6.1 ✅ DO

- **Use `<PanelCard>` / `<KpiCard>` for every panel.** They give you the
  orange stripe header, corner brackets, hover state, and consistent
  spacing in one go.
- **Use the tokens (`nexus-500`, `carbon-900`, …) not hex literals.**
- **Numerics are Orbitron + zinc-50.** Use `nx-metric` or `nx-display`.
- **Labels are DM Mono uppercase with letterspacing.** Use `nx-label`.
- **Match status colour to canonical meaning:** orange = primary /
  focus, emerald = ok, amber = caution, red = fault, sky = info.
- **Test in the real browser with Playwright before declaring done.**
  See §8.
- **Guard every `$_()` call with `$isLoading`.** See §7.
- **For new pages: open `/__ui/#/design` first** to see what's available.

### 6.2 ❌ DON'T

- **Don't reintroduce cyan / blue / purple as a "second brand colour".**
  The single accent is orange.
- **Don't use rounded corners.** Default radius is 2px and stays 2px.
  No `rounded-lg`, no `rounded-xl`, no pill cards (`rounded-full` is
  reserved for `StatusDot`).
- **Don't use soft / floating shadows or glassmorphism.** Industrial
  panels are bolted down; the only shadow is `shadow-industrial`
  (tight, low, dark).
- **Don't use status colours for decoration.** Red is "this is broken",
  not "I want a red border because it looks nice".
- **Don't re-implement panel headers inline.** Use `<PanelCard>` or, if
  you absolutely must, `.nx-panel-head + .nx-stripe`.
- **Don't paint over the dark base with a light card.** No
  `bg-white`, no `bg-base-100` in light mode. The theme is dark-only.
- **Don't add bouncy / spring animations.** `120–200ms ease-out` only.
- **Don't change `index.html`'s `data-theme="industrial"`.** There is
  no light theme.
- **Don't hand-edit `packages/core/src/ui/assets.ts`** — it's
  regenerated by `bun run bundle:ui`.
- **Don't use daisyUI's round `toggle` on dark surfaces.** Its disabled
  state is nearly invisible. Use `<IndustrialToggle>` (or the
  `.nx-toggle` utility classes) — they carry explicit OFF/ON text.
- **Don't load the `material-icons` font** (or any external icon font)
  to render plugin icons. Use `<PluginIcon>` with the built-in ligature
  → SVG mapping. External fonts conflict with the orange-only palette
  and break offline.
- **Don't apply corner brackets to every card in a list / grid.** Pass
  `corners={false}` to `<PanelCard>` for repeating peer items (plugin
  cards, log rows, service tiles, etc.). Brackets are a focus signal;
  if everything is bracketed the page loses hierarchy. See §3.2.1.

### 6.3 ⚠️ Plugin native widgets

Plugins contributing dashboard widgets via `nativeWidgets` **must
follow this system**. The widget renders inside a `<PanelCard flush>`
the host provides, so:

- Don't render your own card chrome.
- Don't import a third-party UI kit (DaisyUI / Skeleton / etc.) that
  conflicts visually.
- Use the `industrial/*` barrel for any sub-components you need.

---

## 7. i18n safety (mandatory)

`svelte-i18n` loads locale resources **asynchronously**. Calling
`$_('foo')` before `$isLoading === false` throws
`Cannot format a message without first setting the initial locale`,
which kills the entire SPA (blank body).

### 7.1 In templates

The root `App.svelte` already wraps the routed area in
`{#if $isLoading}…{:else}…{/if}`. Anything inside that branch is safe.

### 7.2 In `<script>` reactive statements

If you compute something with `$_()` inside a `$:` reactive block, that
block runs **before** i18n is ready and will crash. Guard it:

```ts
// ❌ wrong — crashes on first run
$: navItems = [{ label: $_('nav.dashboard') }, …];

// ✅ correct
$: navItems = $isLoading ? [] : [{ label: $_('nav.dashboard') }, …];
```

### 7.3 In `onMount` and event handlers

Generally safe — by the time the user clicks something or `onMount`
fires, i18n has resolved. But if you do something synchronous in
`onMount` that races, gate on `isLoading` explicitly.

---

## 8. Required testing checklist

Before declaring any UI change "done":

1. **Build cleanly.** `cd packages/ui && bun run build` — no warnings.
2. **Render in a real browser.** HTTP 200 from `curl` is *not enough*;
   JS errors and i18n races don't show up in HTTP status.
3. **Use Playwright headless to take a screenshot** of the affected
   page(s). The probe pattern lives in `/tmp/probe-bungee.mjs` from
   prior sessions; the gist is:
   ```js
   const page = await ctx.newPage();
   page.on('pageerror', (e) => errors.push(e.message));
   await page.goto(URL, { waitUntil: 'networkidle' });
   await page.screenshot({ path: '/tmp/shot.png' });
   ```
4. **Verify the rendered text and DOM are present.** Empty body =
   crash; check `await page.locator('body').innerText()` is non-empty.
5. **Verify zero `pageerror` / console errors / failed network
   requests.**
6. **If hover / interactive state was changed:** trigger it with
   Playwright's `.hover()` / `.focus()` and screenshot both states.
7. **If `data-theme` or `app.css` changed:** spot-check the design
   system page `/__ui/#/design` — it visualises everything in one shot.

---

## 9. File map

| File                                              | Purpose                                |
|---------------------------------------------------|----------------------------------------|
| `packages/ui/tailwind.theme.js`                   | Colour / font / radius / shadow tokens |
| `packages/ui/tailwind.config.js`                  | Theme wiring, DaisyUI bridge           |
| `packages/ui/src/app.css`                         | `nx-*` utility classes                 |
| `packages/ui/index.html`                          | Theme attribute + font preload         |
| `packages/ui/src/lib/components/industrial/`      | Reusable components + barrel `index.ts`|
| `packages/ui/src/routes/DesignSystem.svelte`      | Live design-system showcase (`/#/design`) |
| `packages/ui/docs/INDUSTRIAL_DESIGN_SYSTEM.md`    | **You are here.**                      |

---

## 10. When you change this system

1. Update `INDUSTRIAL_DESIGN_SYSTEM.md` **first** with the rationale and
   the new contract.
2. Update `tailwind.theme.js` / `app.css` / `industrial/*.svelte` to
   match.
3. Update `DesignSystem.svelte` to visualise the change.
4. Run the §8 testing checklist on at least three pages: `/#/`,
   `/#/design`, and one editor page (e.g. `/#/services`).
5. If you added/removed a component, update `industrial/index.ts` and
   the §3.1 reference table here.
6. If you renamed a token or class, search the whole `packages/` for
   stragglers (`rg -n 'old-name'`).

---

## 11. Reference screenshots

The reference visuals that anchor this system are kept under
`/home/smbshare/` on the maintainer's machine (not committed to the
repo — they're inspiration, not artefacts). The two anchors:

- **20:04:20 reference** — original "NEXUS_OS" industrial console
  inspiration (orange stripe headers, panel tags, KPI strip).
- **22:57:47 reference** — close-up showing the corner-bracket detail
  and hover treatment.

The implementation in this repo **adapts** that language to Bungee's
information architecture and terminology; it does **not** copy the
NEXUS_OS scenario, names, or layout. See `feedback_ui_refactor_scope`
memory.
