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
- `/health` is the management health endpoint.
- The data listener at `0.0.0.0:8088` is proxy-only; it has no management
  paths.
- The removed `/__ui` paths return 404. There is no redirect or compatibility
  route.

---

## 2) Dashboard Functional Areas

- Route and upstream inspection
- Runtime statistics and history views
- Config fetch/update/validation
- Optional single-administrator management authentication and plugin-owned Key/route access control
- Plugin management and plugin API integration
- Log query/stream/export and cleanup operations

---

## Management And Access Plugins

- The plugin center preserves the existing BSwitch appearance. Dependencies or guards disable the switch and show the exact reason.
- 管理认证 establishes or verifies one administrator, then hands off to a Cookie session. There are no member or role screens. Disabling it requires the current session and returns to anonymous management.
- 访问控制 provides API Key and route-protection tabs in its settings page. Creating a Key can select allowed routes and explicitly protect the selected public routes. Key permissions and protection are separate; revoking the final Key keeps routes protected.
- Route and Service editors contain proxy configuration only. Public requests remain anonymous even when carrying a Key, and do not consume Key rate or token budgets.
- Key rate limits depend on access control; token budgets depend on access control and metering; statistics depend only on metering. Metering is a global service and cannot bind to routes or services.
- Plugin resource extensions show retained policies read-only when disabled. Publication-pending messages distinguish persisted state from confirmed enforcement.

---

## 3) Customizable Layout

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

---

## 5) Security Notes

- Management is anonymous by default. 管理认证 (`local-accounts`) enables a single administrator session; explicit disabling restores anonymous management. A failed or missing selected provider does not bypass authentication. See [authentication](./authentication.md).
- Plugin asset serving performs path traversal checks and file-type allowlisting.
- CSP and additional browser security headers are applied for plugin HTML assets.
