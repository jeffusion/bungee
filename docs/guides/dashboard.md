# Web Dashboard

The dashboard is served by the management listener. The public data listener
is proxy-only and does not serve management routes.

Default URL:

```text
http://localhost:8089/
```

---

## 1) Routing Model

Management surface:

- `/` serves the dashboard shell; hash routes such as `/#/design` and
  `/#/plugins` are handled by the SPA.
- `/api/*` is forwarded to the management API router.
- `/plugins/*` serves plugin static assets.
- `/health` separates live, management, data and degraded; use `/health/management` or `/health/data` for readiness.
- The data listener at `0.0.0.0:8088` is proxy-only; it has no management
  paths.
- The removed `/__ui` paths return 404. There is no redirect or compatibility
  route.

---

## 2) Dashboard Functional Areas

- Route and upstream inspection
- Runtime statistics and history views
- Config fetch/update/validation
- Optional management account authentication and plugin-owned Key/route access control
- Plugin management and plugin API integration
- Log query/stream/export and cleanup operations

---

## Management And Access Plugins

- The plugin center preserves the existing BSwitch appearance. Dependencies or guards disable the switch and show the exact reason.
- 用户认证 (`user-auth`) is initialized in its activation dialog with a username, password and password confirmation, then establishes a Cookie session. Existing accounts use password verification. The independent `/#/setup` page accepts the account and confirmed password when the selected provider is uninitialized, then returns to login. Cookie-only verification gates the existing Dashboard, navigation and plugin APIs. All logins have full management access; there are no registration, member or role screens. Online disabling cannot release protection; use the offline `release-auth` action.
- 访问控制 provides API Key and route-protection tabs in its settings page. Creating, editing, or applying a Key saves its allowed routes without changing public access. The route switch controls public access independently, including routes with Key grants; revoking the final Key keeps routes protected.
- Route and Service editors contain proxy configuration only. Public requests remain anonymous even when carrying a Key, and do not consume Key rate or token budgets.
- Key rate limits depend on access control; token budgets depend on access control, metering and statistics pricing; statistics depend on metering and models-dev. Metering is a global service and cannot bind to routes or services.
- Plugin resource extensions show retained policies read-only when disabled. Publication-pending messages distinguish persisted state from confirmed enforcement.

---

## 3) Customizable Layout

### Navigation menus

Open **System → Menu management** (`/#/menus`) in the default layout to arrange navigation for
the entire instance. Built-in pages, plugin pages and administration pages can
be reordered, hidden, or moved into one-level groups. The default System group
is editable. Each compact row provides a drag handle, a clickable icon and a
visibility switch. Rows reorder immediately while dragging, with no added gaps. Move over a row
edge to insert before or after it, or over a group center to move inside.
Release inside the list to keep the draft; Escape or release outside cancels
the drag. Groups remain one level deep. **Menu actions** contains move/up/down and move-to-group
controls, plus icon reset and group rename/dissolve. Dissolving a group preserves its pages.

Click a group name to collapse or expand its children. Rename through its action
menu; Enter or blur finishes a valid name, Escape cancels, and invalid names are
marked next to the field. **Draft preview** opens a read-only tree. **Page
actions** contains reload, reset and the read-only page catalog.

Edits and icon choices remain a draft until **Save changes**. Reset restores the
default draft; leaving with unsaved changes asks whether to discard it. Another
editor's newer revision requires reload instead of overwriting their changes.
Other browser windows refresh when brought to the foreground.

Navigation displays all visible top-level pages and groups in the configured
order at every screen width. Groups open dropdowns. There is no automatic
overflow collection or separate mobile panel; use groups, shorter names and
visibility to control the width. The direct Menu management route remains
`/#/menus` if its entry is hidden.
Hiding an entry does not revoke page access or disable its plugin. Disabled
plugin pages are absent from the editor, page catalog and navigation. Their
saved arrangement, visibility and icons are retained for re-enabling.

Pages and groups support default or user-selected icons from the complete local
Lucide, Tabler and Carbon sets. The chooser filters by collection and pages
search results; English names are fully searchable, with maintained common
Chinese keywords. Icon data is served by Bungee and works without Internet
access. Uploading images or SVG is unsupported. Navigation settings are saved
in the instance database, independently of browser-local dashboard card layouts
and proxy configuration publication.

### Dashboard cards

With no saved layout, the dashboard starts with the **LLM gateway** template.
Its top row contains RPM, success rate, average latency (6 columns each), and
Token overview (12 columns). Service and route health occupy the 10-column
left rail. On the right, Token trend spans 20 columns, followed by request /
latency trends, success / failure trends, and upstream distribution / HTTP
status charts in 10-column pairs. Only available, enabled Token Statistics
cards are included. If unavailable, the three top metrics fill the row and
the chart rows close the gap. Plugin metadata loaded after the dashboard
updates this initial template only until a user saves a layout.

**API gateway** remains available with five core metrics, request/latency
trends, service/route health, and upstream failures. Other plugin cards are
never automatically added; all built-in and plugin cards remain in the
library. Existing saved layouts, including intentionally empty layouts,
are preserved.

KPIs extend the existing industrial cards with
sparklines and the change between the latest two completed time buckets, using
the snapshot's time bounds (success-rate changes use percentage points). A zero
request baseline followed by traffic shows an upward "New" indicator; success
and latency trends are unavailable if either bucket has no requests. Hovering
a trend shows the compared time windows. Trend charts retain their grid and visible data
points, with an added gradient fill. Distribution and health bars reuse the
industrial MetricBar, including striped warning/fault states. The minimum KPI
height fits its content and normal padding; narrower cards reserve space for
wrapped text. Mobile compact/standard KPIs use their natural content height.

Use **Customize layout** to add cards from the searchable library, drag their
headers, resize them from the lower-right corner, or choose a size preset. Undo,
cancel, and **Layout templates** work on a draft. Choosing a template replaces
the draft's desktop geometry and mobile order, and remains undoable until
**Save layout** persists the result
in this browser. Layouts are not synchronized between browsers or accounts.
The desktop board uses 30 columns: half width is 15 columns, one-third width is
10. Its base row unit is 37px; minimum KPI content fitting can increase it when
needed. Version 5 doubles the saved vertical coordinates and row spans from
versions 2–4, preserving physical card sizes, positions, and mobile preferences
while allowing finer movement and resizing steps.
Desktop geometry and mobile ordering/heights are independent; removing a card
removes it from both views. Disabled or unavailable plugins retain saved slots.
Desktop cards fill gaps above them while keeping their horizontal positions;
empty space to the left does not trigger automatic rearrangement.

Token overview uses the existing KPI footer for input, output, and cost trends.
It shares the time-series request with Token trend and compares the latest two
completed server buckets (5 minutes, 1 hour, or 2 hours for the selected range).
Unknown usage or prices show a dash; activity after a zero baseline shows New.

Statistics refresh every 30 seconds and pause during layout editing. Runtime
health and configuration recovery continue to use the shared runtime stores.
Failed data reads display an alert and can be retried from the refresh control.

Keyboard: arrow keys on a card handle move it; Shift + arrows resize it. Ctrl/Cmd
+ Z undoes a change, and Ctrl/Cmd + S saves. Leaving with an unsaved draft asks
whether to discard it.

For the dashboard interaction checks, start the UI dev server on port 5185 and
run `bun run --cwd packages/ui test:dashboard`. Override the URL with
`DASHBOARD_BASE_URL` if needed; screenshots are written to
`DASHBOARD_EVIDENCE_DIR` (default `/tmp/bungee-dashboard-evidence`). These checks
mock management APIs and do not modify a running Bungee configuration.
Use `bun run --cwd packages/ui test:dashboard --preview` to capture the default
dashboard without the synthetic plugin used by the interaction checks. The
preview still uses mock statistics and configuration data.

---

## 4) API Surface (served under `/api/*`)

Major endpoint groups:

- Auth: `/api/auth/*`
- Config: `/api/config`, `/api/config/export`, `/api/config/import`, `/api/config/operations/:id`
- Upstream state: `/api/upstreams/:uuid/enabled`
- Stats: `/api/stats*`
- System: `/api/system`
- Plugins: `/api/plugins*`
- Logs: `/api/logs*`
- Navigation and offline icons: `/api/ui/menus`, `/api/ui/icons/*`

---

## 5) Security Notes

- Management is anonymous by default. 用户认证 (`user-auth`) protects management after activation. Use offline, local-terminal `release-auth` to explicitly restore anonymous access. An installed-provider failure preserves authentication; startup clears an absent provider's selection along with its obsolete plugin records. See [authentication](./authentication.md).
- Plugin asset serving performs path traversal checks and file-type allowlisting.
- CSP and additional browser security headers are applied for plugin HTML assets.
