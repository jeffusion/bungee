# Bungee Industrial Design System

> **Status:** authoritative · **Audience:** anyone (human or AI) touching
> `packages/ui/`, plugin native widgets, or any HTML that ships under
> the management UI.
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
`packages/ui/tailwind.theme.js` and exposed through Tailwind utility classes. The runtime still marks the
root with `<html data-theme="industrial">` for app-level theme identity.
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
|             | `zinc-200`       | `#e4e4e7` | Normal field value                       |
|             | `zinc-300`       | `#d4d4d8` | Body text                               |
|             | `zinc-400`       | `#a1a1aa` | Field labels, placeholders, necessary help |
|             | `zinc-500`       | `#71717a` | Secondary metadata / decorative captions |
|             | `zinc-600`       | `#52525b` | Nonessential decorative marks only       |

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

### 2.3 Form text roles

Field labels identify an action or input; they are not decorative captions.
Use the existing `ui/label` primitive, or `nx-field-label` on a native label
or its title span. Both share one CSS definition in `app.css`.

| Role | Colour and typography | Contract |
|------|-----------------------|----------|
| Field label | `zinc-400`, `text-sm`, `font-semibold`, DM Mono, `tracking-command` | `nx-field-label`; do not use `nx-label` / `nx-label-sm` |
| Normal value | `zinc-200`, normal weight | Includes valid “All / 全部” filter states; never style a valid value as a placeholder |
| True placeholder | `zinc-400`, normal weight | Empty input hint only; never replaces an accessible field label |
| Necessary help | `zinc-400`, `text-sm`, normal weight | Instructions needed to understand or complete the field must stay readable |
| Metadata / decorative caption | Existing `nx-label` / `nx-label-sm`, `zinc-500` | Section overlines, IDs and supplementary telemetry; not input titles |
| Disabled | Explicit disabled state, existing cursor and opacity treatment | Independent of empty, readonly and unfiltered states; avoid stacking dimming |

The root is **14px**: `text-sm` is **12.25px**, `text-xs` is **10.5px**,
not 14px and 12px. Check Chinese glyphs as well as English; an AA contrast
ratio alone does not establish comfortable reading at small sizes.
Preserve input sizes, panel geometry and the orange accent when migrating text.

**BSelect single-value reset:** `value=""` selects the explicitly declared
empty-string option when one exists (for example “全部类型 / All types”).
Without such an option it displays the placeholder. Clear always resets to
`""`; at that reset target the clear button is hidden. This API does **not**
represent two different states with the same empty string. Nonempty values
remain visible even before dynamic options load, using the option label or
the existing value fallback. Multiple/tags values and callbacks are unchanged.
The interactive “选择与重置 / Select reset” reference demonstrates both cases.

### 2.4 Geometry

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
**`packages/ui/src/components/industrial/`** and are re-exported
from `industrial/index.ts`. Import via the barrel:

```ts
import {
  PanelCard, KpiCard, CornerBrackets,
  StatusDot, StatusBadge,
  SectionDivider, MetricBar,
  SegmentedControl, HudClock,
  SystemAlertBar, IconButton,
  IndustrialToggle,
} from '$components/industrial';

// Domain-level support components live in src/components/domain/:
import PluginIcon from '$components/domain/plugin/PluginIcon.svelte';
import FeatureBadge from '$components/domain/route/FeatureBadge.svelte';
import HealthSummary from '$components/domain/service/HealthSummary.svelte';
import RelationshipLink from '$components/domain/route/RelationshipLink.svelte';
import ConfirmDialog from '$components/domain/config/ConfirmDialog.svelte';
```

For every component the **prop signature, default behaviour, and
required parent context** are documented inline in the `.svelte` file's
top-of-file comment. Read the source — it's the spec.

### 3.1 Quick reference

| Component        | Purpose                                                   | Where you'd use it                                  |
|------------------|-----------------------------------------------------------|-----------------------------------------------------|
| `PanelCard`      | Generic panel: orange stripe + title + right-side tag     | Wraps every chart, list, form group, or section    |
| `IndustrialDialog` | Shared complex modal: industrial chassis, stationary header/footer, body snippets | Multi-step flows and forms; no domain logic |
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
| `IndustrialToggle` | Flat hard-edged ON/OFF switch with embedded OFF/ON text | Anywhere you'd reach for legacy round switch. Replaces it everywhere on dark surfaces. |
| `BCarouselList` | Measured rows grouped into horizontal carousel pages | Dashboard overview and quota lists that must fit a fixed card height |
| `BCarousel` | Content-first rotation with subtle indicators and contextual navigation | Notices, feature tours, or grouped summaries inside a PanelCard |
| `BSelect` searchable single mode | Field-integrated local filtering or remote incremental loading | Model catalogs, recorded client models and editable aliases |

**Searchable BSelect contract:** use `searchable` for local single-select
filtering or `remoteSearch` for server-backed results. `creatable` shares the
same single-select renderer. Multiple/tags and ordinary local single-select
behavior remain unchanged. Table/list pagination remains explicit.

- Search is typed in the field itself. The popup contains candidates and a
  subtle loading/count/retry footer, never a second search input or page buttons.
  Opening clears the search and starts page 1, preserving the confirmed value
  as the placeholder; closing restores the confirmed value.
- Nonempty remote searches debounce by 250ms and cancel previous work
  immediately. Clearing search loads immediately. Search/provider/catalog
  changes discard accumulated results and reset scroll to the top.
- Scrolling near the bottom requests the next page once and appends results
  without moving focus, resetting scroll or removing previously loaded items.
  Deduplicate by value. Stop when the server's final page is reached.
- Arrow Up/Down navigate enabled candidates; Arrow Down at the loaded boundary
  requests the next page and moves only after it arrives. Enter confirms an
  active candidate, never an arbitrary catalog ID. Creatable values require
  explicit confirmation. IME composition and native editing keys stay native.
- Loading the next page leaves existing options usable. A failed page keeps
  earlier results and exposes retry for that page. A short footer reports
  loaded/total, loading, completion or failure using translated labels; its
  boundary is low contrast, with orange focus emphasis on the field outer edge.
- Escape closes only this dropdown and restores field focus/value. Tab can
  reach retry/custom confirmation; leaving the field and popup dismisses it.
  Outside dismissal, disabling and unmounting cancel requests. Late responses
  cannot replace the current query. Values outside loaded pages remain visible.

Model routing bindings group source and destination separately. Provider fields
reuse searchable BSelect. An unset forwarding target shows a translated
placeholder, never its encoded internal key. Receiving protocols belong to the
binding editor; route/service editors contain transport settings. The binding
editor uses IndustrialDialog with a scrolling body and stationary actions. Its
searchable BSelect popups use fixed positioning outside the body clipping
container; ordinary inline Bits UI selects keep scrollBody=false. Plugin
summaries use translated labels and readable model pairs, not object coercion.

The shared renderer knows no provider or API. Domain adapters supply options,
page status, translated labels and search/cancel callbacks, reusing the existing
abort/generation search service. No global styles or alternate data protocol
are added. The interactive reference is at `/#/design`. Keyboard/combobox
semantics follow the [WAI-ARIA combobox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/).

**BCarousel contract:** import from the industrial barrel. Pass `items` and a
`children(item, index)` snippet; no parent context is required. `index` is
zero-based and bindable. `autoplay` and `loop` default to true, `interval` to
5000ms (minimum 1000ms; invalid values fall back to 5000ms). `onchange(index)`
reports manual/timed navigation. `ariaLabel`, `labels`, `class` and an optional
`empty` snippet customize presentation and accessible copy.

Previous/next arrows, small indicator targets, touch swipes, and
Left/Right/Home/End on the focusable viewport provide manual navigation.
Nested controls retain their own keys and touch interactions.
Autoplay pauses while hovered, focused, or the document is hidden; each
resumption/navigation starts a full interval. A separate pause/play key keeps
the user's pause choice. Reduced-motion preference disables autoplay and
transitions. Non-looping playback stops at the last item; empty/single-item
lists do not start timers or expose navigation. Dynamic lists clamp the index.
Inactive slides are inert and hidden from assistive technology; manual changes
are announced without reading automatic updates. Content remains mounted.

Use a PanelCard for the surrounding chassis. Content is the primary visual;
do not add a second bordered panel, a control toolbar, numbered keys, or a
display counter. Indicators are 3px straight marks in zinc, with a wider active
mark, inside 24px button targets. Show at most five nearby indicators to keep
large collections usable on narrow cards. Arrows and playback use borderless
icon targets and appear on hover or keyboard focus; a deliberately paused
playback control stays visible. Touch users can swipe or tap indicators, and
have a visible small playback control. Focus rings retain the orange token.
These contextual carousel controls are not toolbar hardware keys.
Visual references: [Ant Design carousel tokens](https://ant.design/components/carousel/)
and [Element Plus contextual arrows](https://element-plus.org/en-US/component/carousel.html).
Slides share a grid cell to preserve the tallest item's height; their
opacity transition is 180ms ease-out.
The live `BCarouselExample` demonstrates automatic and non-looping manual use.

**BCarouselList contract:** the industrial barrel also exports a measured list
wrapper that reuses `BCarousel`. Pass `items`, a stable unique `itemKey(item)`,
`children(item, measuring)`, and `ariaLabel`; `labels` customizes accessible
page copy. The parent must allocate a fixed height. `gap` defaults to 12px;
`separated` adds a divider and matching padding between rows. The inert,
aria-hidden measurement layer shares the visible width and row snippet, so
children must be presentational; omit test IDs or other unique IDs when
`measuring` is true. ResizeObserver recalculates complete pages when card size,
text wrapping or row heights change. The active page retains its first row's
stable key on regrouping or reorder, and clamps when that row is removed.

All-fit and single-row lists hide navigation; multiple pages inherit the
5000ms default interval. An oversized individual row keeps native vertical
scrolling. Apply `pan-y pinch-zoom` to both viewport and scrollable slides:
browser gesture arbitration stops at the nearest scroll container, so setting
it only on an outer viewport can cancel a horizontal touch gesture. Vertical
scrolling, pinch zoom and nested input/link activation remain native.
Keep native vertical scroll chaining: wheel/touch scrolling over a slide with
no overflow, or past an overflowing slide's top/bottom, must reach the outer
page. Do not apply `overscroll-contain` to carousel slides; it traps wheel
scrolling even when all content fits. Touch swipe arbitration belongs to
`touch-action`, not scroll-chain isolation.

ChatGPT quota, service overview, route overview, upstream request distribution
and upstream HTTP status distribution use this shared list wrapper. Summary
counts remain outside the rotating rows; rotation itself does not fetch data.


`effect="slide"` opts into horizontal translation (180ms ease-out); the default
remains `"fade"`. `compact` fills a height-constrained parent, inherits its
surface without an inset border or padding, and scrolls long slide content
inside the viewport. Its transparent 24px indicator row keeps contextual
controls clear of account information. The ChatGPT quota widget uses `compact`
and `effect="slide"`, inheriting the default 5000ms interval to rotate pages of
accounts. Accounts are stacked vertically;
the widget measures their natural heights at the current width and packs each
page into the available card body, allowing for dividers and the indicator row.
If all accounts fit, there is one page and no carousel controls. Resizing,
font/language changes and usage updates recalculate the grouping while keeping
the first visible account on screen where possible. A single oversized account
remains scrollable; information is never compressed or clipped to fit more rows.
Its existing host header and
60-second quota-data refresh remain unchanged. Reduced motion disables sliding.

**Domain support components (also industrialized):**

| Component             | Location                              | Purpose                                                       |
|-----------------------|---------------------------------------|---------------------------------------------------------------|
| `FeatureBadge`        | `src/components/domain/route/FeatureBadge.svelte`  | Capability chip for routes (auth/cors/etc.); zinc → orange on hover |
| `HealthSummary`       | `src/components/domain/service/HealthSummary.svelte` | Status dot + uppercase label (HEALTHY/DEGRADED/FAULT/N/A/EMPTY) |
| `RelationshipLink`    | `src/components/domain/route/RelationshipLink.svelte` | Mono link to a related route/service editor; red if broken |
| `ConfirmDialog`       | `src/components/domain/config/ConfirmDialog.svelte` | Modal for destructive actions; auto-maps `confirmClass` to industrial buttons |
| `Toast`/`ToastContainer` | `src/components/shell/Toast.svelte` etc. | Floating top-right notifications with 4 canonical tones      |
| `EndpointQuickPreview`| `src/components/domain/service/EndpointQuickPreview.svelte` | Compact preview of a service's first N endpoints       |
| `PluginIcon`          | `src/components/domain/plugin/PluginIcon.svelte`    | Renders a plugin's `metadata.icon` ligature (transform/shield/wrench/...) as an inline Lucide-style SVG. Falls back to first-letter glyph for unknown ligatures. **No external icon font required.** |

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

`IndustrialDialog` reuses shadcn Dialog Root/Content/Title/Description for
portal, focus and dismissal. Its chassis follows the shell ConfirmDialog and
log ChainDetailModal: raised carbon panel, four brackets, stripe header,
hard-edged close key and carbon footer. `open` is bindable; `title`,
`description`, `busy`, `closeLabel`, `onOpenChange`, `width` (CSS length),
`body`/`footer` snippets and `scrollBody` are its complete API. Default width
is 36rem, capped to viewport minus 2rem. Busy blocks user dismissal, not
programmatic completion. Only the header closes the view; footer actions
perform work (cancelling a remote operation is distinct from closing a view).

The chassis never clips. `scrollBody` defaults to false: inline Select content
must have overflow-visible ancestors. Long text/forms opt into body scrolling;
header/footer remain outside that scroll region. Bits UI **0.22.0**, currently
installed, has neither Select.Portal nor automatic Select.Content portal
(`bits-ui/dist/bits/select/index.js`, `components/select-content.svelte`).
Do not put inline Select inside a scrolling body. Select's own list is height
bounded and scrollable, with viewport collision avoidance; z-index is not a
clipping fix. The live IndustrialDialog example demonstrates long-body scrolling.

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

### 3.4 Component Hierarchy & Architecture

Bungee UI uses a strict multi-layer architecture for component organization. This structure ensures clean boundaries, type safety, and visual consistency.

#### 3.4.1 The Multi-Layer Architecture

1. **Primitive Layer (`components/ui/`)**: This is the industrial-styled shadcn-svelte5 primitive library. It uses the Bits UI version pinned by this package and Tailwind CSS. These components are domain-neutral. They must not contain Bungee domain terms like Route, Service, Upstream, Plugin, or ModelMapping. Every component here is customized immediately to match the carbon and nexus industrial style.
2. **Semantic & Wrapper Layer (`components/industrial/`)**: This layer contains wrapped, encapsulated B* semantic components. These components are product-specific and encapsulate product semantics; business data and API logic belong to domain components. All new wrapped components here use the `B*` prefix.
3. **Business Layer (`components/domain/`)**: This layer contains business-specific components organized by domain: `route`, `service`, `plugin`, `log`, `config`, and `model-mapping`.
4. **Shell Layer (`components/shell/`)**: This layer contains layout and shell components like the top bar, navigation, and HUD.
5. **Charts Layer (`components/charts/`)**: This layer contains chart components like LineChart and MetricBar.
6. **Native Widgets Layer (`components/native-widgets/`)**: This layer contains plugin-contributed widgets that are auto-imported.

#### 3.4.2 Forbidden and Deprecated Layers

* **Legacy form and control wrapper layers are removed and forbidden**: The legacy controls and form wrappers are completely deleted. No new code should reference or create these directories.
* **`Nx*` and removed input compatibility wrappers are completely forbidden**: Historical compatibility is not supported. Old components must be migrated or deleted. They must not be re-exported. Developers must not use them as a migration target or an available path.

#### 3.4.3 Svelte 5 Runes & Snippets

All new and touched components must use Svelte 5 runes. Use `$props()`, `$derived`, `$effect`, and event properties like `onclick` instead of legacy Svelte 4 syntax. Snippets replace legacy slots for passing content.

#### 3.4.4 i18n Guard Rules

Locales load asynchronously. Calling `$_()` inside reactive computations before loading completes will crash the SPA. Always guard reactive blocks:

```ts
let items = $derived($isLoading ? [] : [{ label: $_('nav.dashboard') }]);
```

#### 3.4.5 No DaisyUI

DaisyUI is completely removed from the project. Do not use DaisyUI classes, configurations, or dependencies. All styling must use plain Tailwind CSS and the industrial tokens.

#### 3.4.6 Showcase Page Taxonomy (/#/design)

The design system showcase page at `/#/design` serves as the live catalog and testing ground for all UI elements. It is structured in a progressive hierarchy to guide developers from low-level tokens to high-level domain patterns:

1. **Foundation/Tokens**: Color system, typography, spacing, and geometry.
2. **Basic Components**: Canonical, domain-neutral primitives from `components/ui/` (such as buttons, inputs, and select triggers).
3. **Industrial Components**: Semantic, product-specific `B*` components from `components/industrial/` (such as PanelCard, KpiCard, and StatusBadge).
4. **Domain Patterns**: Complex, composite layouts and domain-specific widgets.

**Showcase Rules:**
* **No Legacy or Compatibility Wrappers**: The `Nx*` and removed input compatibility wrappers are completely forbidden. They must never appear in the main `/design` showcase.
* **No DaisyUI**: DaisyUI is completely forbidden. Don't suggest or use DaisyUI for any new components or showcase examples.

#### 3.4.7 Mandatory component ownership and style isolation

These rules apply to the management UI and **every plugin's UI**:

- Repeated DOM structure and behavior **must be extracted into a shared
  component**. Pages supply data, labels, callbacks and snippets. Do not copy
  markup across pages and couple those copies through shared CSS class names.
- Each component owns its styles in a normal, Svelte-scoped `<style>` block,
  or uses existing Tailwind utilities on its own elements. Its appearance must
  work on a fresh direct visit, without first loading another page.
- **Global styles are forbidden by default.** Do not introduce `:global(...)`,
  `:global { ... }`, global style attributes, standalone stylesheets, component
  CSS `@import`, runtime stylesheet injection, or global CSS imports to style
  page/component DOM. Do not move component styles into `app.css` as a shortcut.
- Style child components through their documented props, variants or snippets.
  Do not use global selectors to reach into a child's internal DOM. If the API
  is insufficient, extend the owning component's API or extract the shared
  structure before adding styles.
- A genuine exception is limited to application theme/reset rules or integration
  with third-party DOM that cannot be styled through an available API. Document
  the exact owner, reason scoped CSS is insufficient, selectors/imports and
  lifecycle in this specification **before implementation**. For third-party
  DOM, anchor selectors to the owning component's scoped root whenever possible;
  never use an unqualified element/class selector that can affect another page.
  The exception requires explicit code review and browser evidence for direct
  entry, page switching, unmounting, and an unrelated page's unchanged styling.
- `global-style-baseline.json` freezes existing global rules (including source
  order, rule bodies and media conditions), `app.css`, and stylesheet imports. It is a
  legacy inventory, **not approval for new global styles**. Component global-rule
  removals are allowed while preserving the remaining order; changes to the
  global foundation in `app.css` require a documented
  exception and corresponding reviewed baseline update. Never refresh the
  baseline merely to make a failing check pass.

`tests/unit/style-scope.test.ts` scans `src/` and all `plugins/*/ui/` directories and
runs in the unit category of the complete CI regression. New or changed global rules, new standalone
stylesheets, template/head style elements or stylesheet links, and unregistered
stylesheet imports fail this check. Reordering frozen rules also fails. Run it locally:

```bash
bun test packages/ui/tests/unit/style-scope.test.ts
```

The route and service editor rails use
`components/shell/EditorNavigation.svelte`. This component owns the navigation
rows, active marker, badges, shortcut DOM and scoped styles. Pages retain their
section definitions and keyboard/save logic; the route template action is a
`betweenPanels` snippet. The shortcut range follows the supplied item count.

---

## 4. CSS utility classes

Defined in `packages/ui/src/app.css` under `@layer components` /
`@layer utilities`. They survive Tailwind purge because the file lists
them explicitly. These are existing foundation/legacy utilities, not permission
to add component-specific global classes. Prefer owning components; apply the
mandatory isolation rules in §3.4.7 to every new or changed UI implementation.

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
| `nx-field-label` | Field title · DM Mono · text-sm (12.25px) · semibold · uppercase · tracking-command · zinc-400 |
| `nx-label`      | Metadata only · DM Mono · 10px · uppercase · `tracking-chiseled` · zinc-500  |
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

Legacy round switch controls are hard to see on the dark carbon surfaces.
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

Prefer the **`<IndustrialToggle>`** component for Svelte. Its API is
`checked` (bindable), `onchange(checked)`, `disabled`, `id`, and a required
accessible `label`. The ON/OFF track sits inside a 44px touch target
(40px on desktop); its `role="switch"` key supports Space and Enter.

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

### 4.8 Page width

Page width uses a single semantic standard. The root font-size is `14px`.
Tailwind `max-w-screen-xl` is a fixed `1280px`.

| Utility | Contract | Use |
|---------|----------|-----|
| `.nx-page` | Standard `1280px` centered container, full width below the cap, with `px-4 sm:px-6` | All pages |

The utility keeps the title, KPI strip, controls, and body on one shared
content axis. Do not introduce other page-width tiers.

---

## 5. Page composition recipes

### 5.1 Page width

Use `.nx-page` for `Dashboard`, `ServicesIndex`, `ServiceEditor`,
`RoutesIndex`, `RouteEditor`, `Configuration`, `Plugins`, `PluginDetailLayout`,
`DesignSystem`, `Logs`, and the extension `PluginHost`.

`Login` and `NotFound` are excluded because they use purpose-built narrow
layouts. Every other page uses the single standard width.

The page title, KPI strip, controls, and body must share one content axis.

### 5.2 Standard page header

```html
<div class="nx-page py-5 space-y-5">
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

### 5.3 KPI strip (5 cards, equal width)

```html
<section class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
  <KpiCard label="..." value="..." unit="..." trend={1.2} />
  <!-- ... -->
</section>
```

### 5.4 Section group (chart / list / form panels)

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

### 5.5 Logical separator between sections

```html
<SectionDivider label="EXTENSIONS" />
```

### 5.6 Footer attention strip

```html
<SystemAlertBar
  tone="info"
  title="..."
  subtitle="..."
>
  <a slot="action" href="..." class="nx-btn-outline">DETAILS</a>
</SystemAlertBar>
```

### 5.7 List-row inside a panel

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

### 5.8 Shell navigation: business vs administration

The Header's primary navigation belongs to business pages: Dashboard, Routes,
Services, Request Logs, and enabled plugin navigation contributions. Plugin
pages are peers of built-in business pages, never children of plugin management.

Global Settings and Plugins belong exclusively to the right-hand **System**
dropdown, alongside language selection and authenticated sign-out. Use the
existing shadcn DropdownMenu primitives; preserve native navigation links and
the shared unsaved-changes guard. When a management page is active, highlight
the System trigger and its matching menu item, not an unrelated business tab.

Below 768px, the **Pages** Sheet contains only business navigation. The separate
System trigger remains on the Header; do not merge administration back into the
Sheet. The Pages trigger and Sheet controls use the shared 34px ghost Button
styling; keep the System trigger at least 44px high. Preserve keyboard dismissal
and focus restoration, and wait until the menu has released its modal state before
opening sign-out confirmation. The HUD clock is shown from 1280px upward to
prioritize page navigation on narrower desktops. Navigation overflow scrolls
horizontally without changing the Header's height.

---

## 6. Hard rules — do this, not that

### 6.1 ✅ DO

- **Use `<PanelCard>` / `<KpiCard>` for every panel.** They give you the
  orange stripe header, corner brackets, hover state, and consistent
  spacing in one go.
- **Use the tokens (`nexus-500`, `carbon-900`, …) not hex literals.**
- **Numerics are Orbitron + zinc-50.** Use `nx-metric` or `nx-display`.
- **Field labels use `ui/label` or `nx-field-label`.** Reserve `nx-label`
  and `nx-label-sm` for metadata, not form titles. See the form text roles in §2.3.
- **Match status colour to canonical meaning:** orange = primary /
  focus, emerald = ok, amber = caution, red = fault, sky = info.
- **Test in the real browser with Playwright before declaring done.**
  See §8.
- **Guard every `$_()` call with `$isLoading`.** See §7.
- **For new pages: open `/#/design` first** to see what's available.

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
- **Don't use unconstrained top-level full-width wrappers.** Use `.nx-page`,
  not raw `max-w-*` classes.
- **Don't paint over the dark base with a light card.** No
  `bg-white` or light-mode panel fills. The theme is dark-only.
- **Don't add bouncy / spring animations.** `120–200ms ease-out` only.
- **Don't change `index.html`'s `data-theme="industrial"`.** There is
  no light theme.
- **Don't hand-edit `packages/core/src/ui/assets.ts`** — it's
  regenerated by `bun run bundle:ui`.
- **Don't use legacy round switch on dark surfaces.** Its disabled
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
- Don't import a third-party UI kit that conflicts visually.
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
   page(s). Use the maintained smoke or package-local browser tests; for a focused check:
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
   system page `/#/design` — it visualises everything in one shot.

### 8.1 CI Integration & Smoke Tests

The project uses automated checks to enforce the industrial design system and prevent regressions.

1. **Import and translation boundaries**: `bun test --isolate packages/ui/tests/unit/ui-boundaries.test.ts` checks actual imports and reactive translation syntax. Comment text and historical migration quotas do not define architectural boundaries.
2. **Playwright regressions**: `bun run test:browser` includes smoke, route editor, scrolling and dashboard native widget checks. Tests start their own local services; CI selects browser files by module on Linux/macOS; UI and plugin UI changes select the entire UI/plugin browser scope and root workflows. Full regression remains required before release. Build current artifacts before running a category directly. See the [development testing guide](../../../docs/guides/development.md#6-testing-strategy).
3. **Style isolation**: `bun test --isolate packages/ui/tests/unit/style-scope.test.ts` enforces the frozen global-style baseline. Global styles require the documented narrow reviewed exception in §3.4.7; reorganizing tests must not broaden it.

Built-page tests serve the current `dist` through the owned static runtime; component hosts use the existing Vite configuration with private caches. A file owns its service and browser, with a fresh context per test; do not share mutable runtimes across files. Wait for request completion, rendered state or stable layout rather than fixed preparation delays. Keep representative success screenshots and necessary state/layout evidence; collect additional screenshots for diagnosis. Cleanup failures must fail the check.

Keep component tests under `tests/browser/`, pure logic under `tests/unit/`, and loaded hosts under `tests/fixtures/`. Test behavior through normal module imports or real rendering; never extract component source and execute it. Evidence belongs outside versioned source.

---

## 9. File map

| File                                              | Purpose                                |
|---------------------------------------------------|----------------------------------------|
| `packages/ui/tailwind.theme.js`                   | Colour / font / radius / shadow tokens |
| `packages/ui/tailwind.config.js`                  | Tailwind content scan and token wiring |
| `packages/ui/src/app.css`                         | `nx-*` utility classes                 |
| `packages/ui/index.html`                          | Theme attribute + font preload         |
| `packages/ui/src/components/industrial/`      | Reusable components + barrel `index.ts`|
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

## 11. Reference and integer inputs

The maintained visual reference is `/#/design`, implemented by `src/routes/DesignSystem.svelte`. Repository screenshots illustrate the product; personal inspiration files and session memory are not project dependencies.

Use `ui/number-input` for bounded integer fields. It accepts ASCII digits only, rejects invalid paste as a whole, and publishes undefined when cleared. Required validation prevents empty submission. Editing may temporarily exceed min/max; blur or Enter clamps and removes leading zeros. Buttons and arrow keys step by one, respect bounds/disabled/readonly, and never submit a form. Preserve text selection, external-value synchronization and spinbutton accessibility. The server still validates integers and ranges.

The component check is `bun test --isolate packages/ui/tests/browser/number-input.test.ts`; domain ranges belong to the [models-dev contract](../../../plugins/models-dev/README.md).
