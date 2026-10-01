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
- Plugin management and plugin API integration
- Log query/stream/export and cleanup operations

---

## 3) Customizable Layout

The dashboard retains the original five metric cards, all seven monitoring charts,
and service/route health cards. KPIs extend the existing industrial cards with
sparklines and the change between the latest two completed time buckets, using
the snapshot's time bounds (success-rate changes use percentage points). A zero
request baseline followed by traffic shows an upward "New" indicator; success
and latency trends are unavailable if either bucket has no requests. Hovering
a trend shows the compared time windows. Trend charts retain their grid and visible data
points, with an added gradient fill. Distribution and health bars reuse the
industrial MetricBar, including striped warning/fault states. The minimum KPI
height fits its content and normal padding; narrower cards reserve space for
wrapped text. Mobile compact/standard KPIs use their natural content height.
Installed plugin widgets are included when no saved layout exists.

Use **Customize layout** to add cards from the searchable library, drag their
headers, resize them from the lower-right corner, or choose a size preset. Undo,
cancel, and restore defaults work on a draft; **Save layout** persists the result
in this browser. Layouts are not synchronized between browsers or accounts.
The desktop board uses 30 columns: half width is 15 columns, one-third width is
10, and each of the five default KPI cards spans 6. Existing 12- and 15-column
browser layouts are migrated without dropping cards or mobile preferences.
Desktop geometry and mobile ordering/heights are independent; removing a card
removes it from both views. Disabled or unavailable plugins retain saved slots.
Desktop cards fill gaps above them while keeping their horizontal positions;
empty space to the left does not trigger automatic rearrangement.

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

- UI API can require auth if global auth is enabled.
- Plugin asset serving performs path traversal checks and file-type allowlisting.
- CSP and additional browser security headers are applied for plugin HTML assets.
