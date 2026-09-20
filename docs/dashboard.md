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

## 3) API Surface (served under `/api/*`)

Major endpoint groups:

- Auth: `/api/auth/*`
- Config: `/api/config`, `/api/config/export`, `/api/config/import`, `/api/config/operations/:id`
- Upstream state: `/api/upstreams/:uuid/enabled`
- Stats: `/api/stats*`
- System: `/api/system`
- Plugins: `/api/plugins*`
- Logs: `/api/logs*`

---

## 4) Security Notes

- UI API can require auth if global auth is enabled.
- Plugin asset serving performs path traversal checks and file-type allowlisting.
- CSP and additional browser security headers are applied for plugin HTML assets.
