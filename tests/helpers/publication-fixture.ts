import { setTimeout as sleep } from 'node:timers/promises';
import type { PublicationPolicy } from '@jeffusion/bungee-types';

// Simulated process tests must finish inside the runner's deadline. Handoff and
// worker drain each consume D; these values do not change production defaults.
export const FIXTURE_PUBLICATION_POLICY: Readonly<PublicationPolicy> = Object.freeze({
  drain_start_timeout_ms: 5_000,
  drain_timeout_ms: 10_000,
  worker_exit_timeout_ms: 10_000,
});
export const FIXTURE_STARTUP_WAIT_MS = 60_000;
export const FIXTURE_PUBLICATION_WAIT_MS = 30_000 // replacement apply window
  + 2 * FIXTURE_PUBLICATION_POLICY.drain_timeout_ms
  + FIXTURE_PUBLICATION_POLICY.drain_start_timeout_ms
  + FIXTURE_PUBLICATION_POLICY.worker_exit_timeout_ms
  + 10_000; // process queries and scheduling margin
export const FIXTURE_REQUEST_TIMEOUT_MS = 1_000;

export async function waitForFixturePublication(options: {
  base: string;
  revision: number;
  childExited: () => boolean;
  timeoutMs?: number;
}): Promise<void> {
  const deadline = new AbortController();
  const timeoutMs = options.timeoutMs ?? FIXTURE_STARTUP_WAIT_MS;
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  let lastStatus: number | null = null;
  let publicationState: string | null = null;
  let recoveryState: string | null = null;
  try {
    while (!deadline.signal.aborted) {
      if (options.childExited()) throw new Error('fixture master exited before publication readiness');
      let ready = false;
      try {
        const response = await fetch(`${options.base}/api/config/runtime`, {
          signal: AbortSignal.any([deadline.signal, AbortSignal.timeout(FIXTURE_REQUEST_TIMEOUT_MS)]),
        });
        lastStatus = response.status;
        if (response.ok) {
          const body = await response.json();
          const publication = body.publication;
          const state = publication?.operation?.state;
          publicationState = ['committed', 'publishing', 'draining', 'converged', 'degraded', 'failed'].includes(state) ? state : null;
          const recovery = publication?.recovery?.state;
          recoveryState = ['scheduled', 'running', 'succeeded', 'stopped'].includes(recovery) ? recovery : null;
          ready = publication?.serving_complete === true && publication.serving_revision === options.revision;
        } else {
          // Consume responses so polling does not leave connections outstanding.
          await response.body?.cancel();
        }
      } catch { /* transient transport failures share the same absolute deadline */ }
      if (deadline.signal.aborted) break;
      if (options.childExited()) throw new Error('fixture master exited before publication readiness');
      if (ready) return;
      if (publicationState === 'failed' || recoveryState === 'stopped') {
        throw new Error(`fixture publication stopped (publication=${publicationState} recovery=${recoveryState})`);
      }
      await sleep(100, undefined, { signal: deadline.signal }).catch(() => undefined);
    }
    throw new Error(`fixture publication deadline exceeded (revision=${options.revision} timeoutMs=${timeoutMs} httpStatus=${lastStatus} publication=${publicationState} recovery=${recoveryState})`);
  } finally { clearTimeout(timer); }
}
