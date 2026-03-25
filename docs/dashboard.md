# Web Dashboard

The dashboard is served by core runtime under the reserved `/__ui` prefix.

Default URL:

```text
http://localhost:8088/__ui/
```

---

## 1) Routing Model

`handleUIRequest()` behavior:

- Only handles paths starting with `/__ui`
- `/__ui/api/*` is forwarded to API router
- Static bundled assets are served from embedded UI bundle
- Unknown non-file paths fall back to `index.html` (SPA routing)

---

## 2) Dashboard Functional Areas

- Route and upstream inspection
- Runtime statistics and history views
- Config fetch/update/validation
- System reload/restart actions
- Plugin management and plugin API integration
- Log query/stream/export and cleanup operations

---

## 3) API Surface (served under `/__ui/api/*`)

Major endpoint groups:

- Auth: `/api/auth/*`
- Config: `/api/config`, `/api/config/validate`
- Routes/upstreams: `/api/routes`, `/api/routes/:route/upstreams/:index/(enable|disable)`
- Stats: `/api/stats*`
- System: `/api/system`, `/api/system/reload`, `/api/system/restart`
- Plugins: `/api/plugins*`
- Logs: `/api/logs*`

---

## 4) Security Notes

- UI API can require auth if global auth is enabled.
- Plugin asset serving performs path traversal checks and file-type allowlisting.
- CSP and additional browser security headers are applied for plugin HTML assets.
