import { requestPluginControl } from '@bungee/plugin-sdk';
import type { TpsStatsResponse } from '../contract';
import { createTpsResources } from './stats-resource';

const resources = createTpsResources((plugin, range, signal) =>
  requestPluginControl<TpsStatsResponse>(plugin, `/stats?range=${range}`, 'GET', undefined, signal));
export const getTpsResource = resources.get;
