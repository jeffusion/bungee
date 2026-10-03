import { requestPluginControl } from '@bungee/plugin-sdk';
import { createStatsResource, statsQuery, type StatsRange, type StatsResource, type StatsResponse } from './stats-resource';

const resources = new Map<string, StatsResource>();
export function getStatsResource(pluginName: string, range: StatsRange, groupBy: 'model' | 'time', keyId?: string): StatsResource {
  const timeZone = ['day', 'week', 'month'].includes(range) ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined;
  const { key, path } = statsQuery(pluginName, range, groupBy, keyId, timeZone);
  let resource = resources.get(key);
  if (!resource) {
    resource = createStatsResource(signal => requestPluginControl<StatsResponse>(pluginName,
      path, 'GET', undefined, signal),
    () => { if (resources.get(key) === resource) resources.delete(key); });
    resources.set(key, resource);
  }
  return resource;
}
