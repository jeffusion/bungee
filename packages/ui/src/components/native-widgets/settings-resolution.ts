import type { Plugin } from '$api/plugins';

/** Only a build-time registry entry owned by this plugin can render natively. */
export function resolveNativeSettings<T>(plugin: Plugin, currentPath: string, registry: Record<string, T>, owners: Record<string, string>) {
  const name = plugin.metadata?.contributes?.nativeSettingsComponent;
  if (name === undefined) return { kind: 'sandbox' } as const;
  if (!plugin.metadata?.contributes?.settings || currentPath !== plugin.metadata.contributes.settings) {
    return { kind: 'error', message: `原生设置路径不匹配：${currentPath}。已阻止加载，请打开插件声明的设置路径。` } as const;
  }
  if (!Object.hasOwn(registry, name) || !registry[name]) {
    return { kind: 'error', message: `原生设置组件未注册：${name || '（空名称）'}。请更新并重新构建界面。` } as const;
  }
  if (!Object.hasOwn(owners, name) || owners[name] !== plugin.name) {
    return { kind: 'error', message: `原生设置组件归属不匹配：${name} 不属于 ${plugin.name}。已阻止加载。` } as const;
  }
  return { kind: 'native', component: registry[name] } as const;
}
