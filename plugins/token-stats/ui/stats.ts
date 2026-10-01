import { requestPluginControl } from '@bungee/plugin-sdk';
import { createStatsResource, type StatsRange, type StatsResource, type StatsResponse } from './stats-resource';

const resources = new Map<string, StatsResource>();
export function getStatsResource(pluginName: string, range: StatsRange, groupBy: 'model' | 'time'): StatsResource {
  const timeZone = ['week', 'month'].includes(range) ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined;
  const key = `${pluginName}:${range}:${groupBy}:${timeZone ?? ''}`;
  let resource = resources.get(key);
  if (!resource) {
    resource = createStatsResource(signal => requestPluginControl<StatsResponse>(pluginName,
      `/stats?range=${encodeURIComponent(range)}&groupBy=${groupBy}${timeZone ? `&timeZone=${encodeURIComponent(timeZone)}` : ''}`, 'GET', undefined, signal),
    () => { if (resources.get(key) === resource) resources.delete(key); });
    resources.set(key, resource);
  }
  return resource;
}
