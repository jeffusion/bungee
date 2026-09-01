import type { PublicationScheduler, ScheduledTimeout } from '../config-publication/coordinator-types';

export const timeoutScheduler: PublicationScheduler = {
  schedule(delayMs: number, callback: () => void): ScheduledTimeout {
    const timeout = setTimeout(callback, delayMs);
    return { cancel: () => clearTimeout(timeout) };
  },
};
