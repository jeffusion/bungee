import type { Plugin } from '$api/plugins';

export function allowedControlRequest(plugin: Plugin, path: unknown, method: unknown): path is string {
  if (typeof path !== 'string' || path.length > 4096 || !/^\/[a-zA-Z0-9/_-]*(?:\?[^#\\]*)?$/.test(path) || path.includes('//')) return false;
  const pathname = path.split('?')[0];
  return !!plugin.metadata?.contributes?.api?.some(api => api.execution === 'control' && api.path === pathname && api.methods.includes(method as never));
}

export function safeExternalUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
