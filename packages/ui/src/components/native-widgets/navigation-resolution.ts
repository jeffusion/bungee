import type { Plugin } from '$api/plugins';

/** Native navigation uses the same build-time registry and ownership checks as widgets/settings. */
export function resolveNativeNavigation<T>(plugin: Plugin, path: string, registry: Record<string, T>, owners: Record<string, string>) {
  const page = plugin.metadata?.contributes?.navigation?.find(item => item.path === path && item.component !== undefined);
  if (!page) return null;
  const name = page.component!;
  if (!Object.hasOwn(registry, name) || !registry[name] || !Object.hasOwn(owners, name) || owners[name] !== plugin.name) {
    return { kind: 'error', message: `原生页面组件未注册或归属不匹配：${name}。请更新并重新构建界面。` } as const;
  }
  return { kind: 'native', component: registry[name] } as const;
}
