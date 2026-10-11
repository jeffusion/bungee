
    export async function getConfig() {
      await Promise.resolve();
      if (window.scenario === 'config-failed') throw new Error('Config API 500');
      return { logging: { body: { enabled: window.scenario === 'missing-ids' } } };
    }
