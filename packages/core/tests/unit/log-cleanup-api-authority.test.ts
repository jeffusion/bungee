import { afterEach, describe, expect, test } from 'bun:test';
import { handleAPIRequest } from '../../src/api/router';
import { clearServingConfig, setServingConfig } from '../../src/api/serving-config';
import { logCleanupService } from '../../src/logger/log-cleanup';

afterEach(clearServingConfig);

describe('worker log cleanup API authority', () => {
  test('does not mutate worker-local cleanup config when PUT targets the removed config route', async () => {
    // Given
    setServingConfig({ routes: [] }, []);
    const initialConfig = logCleanupService.getConfig();
    const requestedConfig = {
      enabled: !initialConfig.enabled,
      retentionDays: initialConfig.retentionDays + 1,
      scheduleIntervalHours: initialConfig.scheduleIntervalHours + 1,
    };

    // When
    const response = await handleAPIRequest(
      new Request('http://localhost/api/logs/cleanup/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestedConfig),
      }),
      '/api/logs/cleanup/config',
    );

    // Then
    expect(response.status).toBe(404);
    expect(logCleanupService.getConfig()).toEqual(initialConfig);
  });
});
