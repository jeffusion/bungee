import type { PluginInitContext } from '@jeffusion/bungee-core/plugin';

export interface RedactionStats {
  processedRequests: number;
  redactedRequests: number;
  replacements: number;
  reportingIncomplete: boolean;
}

export function createStatsRecorder(context: PluginInitContext) {
  const invoke = context.storage.invokeObservation?.bind(context.storage);
  let processed = 0;
  let redacted = 0;
  let replacements = 0;
  let incomplete = false;
  let writing: Promise<void> | undefined;

  function flush() {
    if (writing || !invoke || processed === 0 && !incomplete) return;
    const batch = [processed, redacted, replacements, incomplete];
    processed = redacted = replacements = 0;
    writing = Promise.resolve().then(() => invoke<void>('record', batch)).then(() => {
      incomplete = false;
      writing = undefined;
      flush();
    }, () => {
      // An RPC error does not prove the delta was not committed; never send it twice.
      if (!incomplete) context.logger.warn('request-body-redaction statistics may be incomplete');
      incomplete = true;
      writing = undefined;
    });
  }

  return {
    record(count: number) {
      if (!invoke) return;
      processed++;
      if (count > 0) redacted++;
      replacements += count;
      flush();
    },
    async close() {
      while (writing) await writing;
      flush();
      while (writing) await writing;
    },
  };
}
