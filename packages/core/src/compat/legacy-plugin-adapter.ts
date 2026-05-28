import type { AppConfig, InterceptResult } from '@jeffusion/bungee-types';

/**
 * Pluggable legacy compatibility adapter.
 * DELETE this file + remove all imports to clean up legacy support.
 */
export class LegacyCompatAdapter {
  static adaptConfig(config: AppConfig): AppConfig {
    if (!config.services) return config;
    return {
      ...config,
      services: config.services.map((service) => ({
        ...service,
        plugins: service.plugins ?? [],
      })),
    };
  }

  static adaptInterceptResult(result: InterceptResult | Response | undefined): InterceptResult {
    if (result === undefined) return undefined;
    if (result instanceof Response) {
      return { action: 'respond', response: result };
    }
    return result;
  }
}
