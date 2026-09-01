const EXACT_MANAGEMENT_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/verify',
  '/api/config',
  '/api/config/runtime',
  '/api/config/validate',
  '/api/config/export',
  '/api/config/import',
  '/api/routes',
  '/api/stats',
  '/api/stats/history',
  '/api/stats/history/v2',
  '/api/stats/upstream-stats',
  '/api/stats/upstream-distribution',
  '/api/stats/upstream-failures',
  '/api/stats/upstream-status-codes',
  '/api/stats/upstreams/last-used',
  '/api/system',
  '/api/transformers',
  '/api/plugins',
  '/api/plugins/schemas',
  '/api/plugins/model-mapping/catalog',
  '/api/plugins/model-mapping/catalog/refresh',
  '/api/plugin-translations',
  '/api/logs',
]);

export function normalizeManagementPath(pathname: string): string {
  return pathname === '/__ui/api' || pathname.startsWith('/__ui/api/')
    ? `/api${pathname.slice('/__ui/api'.length)}`
    : pathname;
}

export function isManagementApiPath(request: Request): boolean {
  const path = normalizeManagementPath(new URL(request.url).pathname);
  return EXACT_MANAGEMENT_PATHS.has(path)
    || path.startsWith('/api/transformers/')
    || /^\/api\/plugins\/[^/]+\/.+$/.test(path)
    || path.startsWith('/api/logs/')
    || /^\/api\/config\/operations\/[^/]+$/.test(path)
    || /^\/api\/upstreams\/[^/]+\/enabled$/.test(path);
}
