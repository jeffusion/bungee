import { writable } from 'svelte/store';
import { PluginsAPI, type Plugin } from '$api/plugins';
import { toast } from './toast';

// Create a writable store for the plugin list
export const pluginList = writable<Plugin[]>([]);
export const pluginsLoading = writable<boolean>(true);

// Function to refresh the plugin list from the API
export async function refreshPlugins(silent = false) {
  if (!silent) pluginsLoading.set(true);
  try {
    const plugins = await PluginsAPI.list();
    pluginList.set(plugins);
  } catch (e: any) {
    console.error('Failed to load plugins:', e);
    if (!silent) toast.show('Failed to refresh plugins: ' + e.message, 'error');
  } finally {
    if (!silent) pluginsLoading.set(false);
  }
}

export function updatePluginState(name: string, enabled: boolean) {
  pluginList.update(list => {
    return list.map(p => {
      if (p.name === name) {
        return { ...p, enabled };
      }
      return p;
    });
  });
}
