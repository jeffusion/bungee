import type { Sha256Digest } from '@jeffusion/bungee-types';
import { parseConfigWorkerMessage } from './worker-messages';
import { sameProcessIdentity, samePublicationIdentity } from './message-fields';
import {
  ConfigPublicationMessageError,
  type ConfigPublicationIdentity,
  type ConfigReadyMessage,
  type ConfigWorkerMessage,
} from './types';
import type {
  ConfigPublicationWorkerProcess,
  PublicationFailure,
  PublicationScheduler,
  ScheduledTimeout,
  ServingConfigWorker,
} from './coordinator-types';
import { bestEffort, boundedError } from './waiter-safety';

export type ApplyExpectation = {
  readonly revision: number;
  readonly contentHash: Sha256Digest;
  readonly pluginCatalogHash: Sha256Digest;
  readonly expectedPrivatePort?: number;
  readonly publication: ConfigPublicationIdentity | null;
};

export type ApplyDecision =
  | { readonly kind: 'ready'; readonly evidence: ConfigReadyMessage }
  | { readonly kind: 'failed'; readonly failure: PublicationFailure };

export type ApplyWaitHandle = {
  readonly result: Promise<ApplyDecision>;
  fail(failure: PublicationFailure): void;
};

export type DrainWaitHandle = {
  readonly result: Promise<PublicationFailure | null>;
  fail(failure: PublicationFailure): void;
};

type ApplyWaitOptions = {
  readonly process: ConfigPublicationWorkerProcess;
  readonly expected: ApplyExpectation;
  readonly scheduler: PublicationScheduler;
  readonly timeoutMs: number;
};

function configLooking(input: unknown): boolean {
  if (typeof input !== 'object' || input === null) return false;
  try {
    const status = Object.getOwnPropertyDescriptor(input, 'status')?.value;
    const command = Object.getOwnPropertyDescriptor(input, 'command')?.value;
    return (typeof status === 'string' && (status.startsWith('config-') || status === 'worker-drained'))
      || (typeof command === 'string' && (command.includes('config') || command === 'drain-worker'));
  } catch {
    return true;
  }
}

function failure(slot: number, code: PublicationFailure['code'], detail: string): ApplyDecision {
  return { kind: 'failed', failure: { slot, code, detail } };
}

export function waitForApply(options: ApplyWaitOptions): ApplyWaitHandle {
  const { process, expected, scheduler, timeoutMs } = options;
  let fail = (_failure: PublicationFailure): void => undefined;
  const result = new Promise<ApplyDecision>((resolve) => {
    let timeout: ScheduledTimeout = { cancel: () => undefined };
    let unsubscribeMessage = (): void => undefined;
    let unsubscribeExit = (): void => undefined;
    let settled = false;
    const settle = (decision: ApplyDecision): void => {
      if (settled) return;
      settled = true;
      bestEffort(() => { timeout.cancel(); });
      bestEffort(unsubscribeMessage);
      bestEffort(unsubscribeExit);
      resolve(decision);
    };
    fail = (applyFailure) => { settle({ kind: 'failed', failure: applyFailure }); };
    try {
      const messageSubscription = process.subscribeMessage((input) => {
        let message: ConfigWorkerMessage;
        try { message = parseConfigWorkerMessage(input); }
        catch (error) {
          if (error instanceof ConfigPublicationMessageError && configLooking(input)) {
            settle(failure(process.slot, 'invalid_message', error.message.slice(0, 512)));
          }
          return;
        }
        if (!('status' in message)) return;
        if (message.status === 'config-ready') {
          const processIdentity = process.slot === process.identity.worker_slot
            && sameProcessIdentity(message, process.identity) && message.pid === process.pid
            && message.revision === expected.revision && message.content_hash === expected.contentHash
            && message.plugin_catalog_hash === expected.pluginCatalogHash
            && (expected.expectedPrivatePort === undefined
              || message.private_port === expected.expectedPrivatePort)
            && samePublicationIdentity(message.publication, expected.publication);
          settle(processIdentity ? { kind: 'ready', evidence: message }
            : failure(process.slot, 'mismatched_message', 'config-ready identity mismatch'));
          return;
        }
        if (message.status === 'config-apply-failed') {
          const processIdentity = sameProcessIdentity(message, process.identity) && message.pid === process.pid
            && message.target_revision === expected.revision && message.target_content_hash === expected.contentHash
            && message.target_plugin_catalog_hash === expected.pluginCatalogHash
            && samePublicationIdentity(message.publication, expected.publication);
          settle(failure(process.slot, processIdentity ? 'apply_failed' : 'mismatched_message',
            processIdentity ? message.error.slice(0, 512) : 'config-apply-failed identity mismatch'));
          return;
        }
        if (message.status === 'worker-drained') {
          settle(failure(process.slot, 'mismatched_message', 'unexpected worker-drained message'));
        }
      });
      unsubscribeMessage = messageSubscription;
      if (settled) bestEffort(unsubscribeMessage);
      const exitSubscription = process.subscribeExit((evidence) => {
        if (evidence.pid !== process.pid) return;
        settle(failure(process.slot, 'early_exit', 'worker exited before config-ready'));
      });
      unsubscribeExit = exitSubscription;
      if (settled) bestEffort(unsubscribeExit);
      timeout = scheduler.schedule(timeoutMs, () => {
        settle(failure(process.slot, 'timeout', 'worker config-ready timed out'));
      });
      if (settled) bestEffort(() => { timeout.cancel(); });
    } catch (error) {
      settle(failure(process.slot, 'apply_failed', boundedError(error, 'worker waiter initialization failed')));
    }
  });
  return { result, fail };
}

type DrainWaitOptions = {
  readonly worker: ServingConfigWorker;
  readonly scheduler: PublicationScheduler;
  readonly timeoutMs: number;
};

export function waitForDrainAck(options: DrainWaitOptions): DrainWaitHandle {
  const { worker, scheduler, timeoutMs } = options;
  const { process } = worker;
  let fail = (_failure: PublicationFailure): void => undefined;
  const result = new Promise<PublicationFailure | null>((resolve) => {
    let timeout: ScheduledTimeout = { cancel: () => undefined };
    let unsubscribeMessage = (): void => undefined;
    let unsubscribeExit = (): void => undefined;
    let settled = false;
    const finish = (value: PublicationFailure | null): void => {
      if (settled) return;
      settled = true;
      bestEffort(() => { timeout.cancel(); });
      bestEffort(unsubscribeMessage);
      bestEffort(unsubscribeExit);
      resolve(value);
    };
    fail = finish;
    try {
      const messageSubscription = process.subscribeMessage((input) => {
        let message: ConfigWorkerMessage;
        try { message = parseConfigWorkerMessage(input); }
        catch (error) {
          if (error instanceof ConfigPublicationMessageError && configLooking(input)) {
            finish({ slot: process.slot, code: 'invalid_message', detail: error.message.slice(0, 512) });
          }
          return;
        }
        if (!('status' in message)) return;
        if (message.status !== 'worker-drained') {
          finish({ slot: process.slot, code: 'mismatched_message',
            detail: 'unexpected config message while draining' });
          return;
        }
        const exact = sameProcessIdentity(message, process.identity) && message.pid === process.pid
          && message.revision === worker.revision && message.content_hash === worker.content_hash
          && message.plugin_catalog_hash === worker.plugin_catalog_hash
          && samePublicationIdentity(message.publication, worker.publication);
        finish(exact ? null : { slot: process.slot, code: 'mismatched_message',
          detail: 'worker-drained identity mismatch' });
      });
      unsubscribeMessage = messageSubscription;
      if (settled) bestEffort(unsubscribeMessage);
      const exitSubscription = process.subscribeExit((evidence) => {
        if (evidence.pid !== process.pid) return;
        finish({ slot: process.slot, code: 'early_exit', detail: 'worker exited before drain acknowledgement' });
      });
      unsubscribeExit = exitSubscription;
      if (settled) bestEffort(unsubscribeExit);
      timeout = scheduler.schedule(timeoutMs, () => {
        finish({ slot: process.slot, code: 'timeout', detail: 'worker drain timed out' });
      });
      if (settled) bestEffort(() => { timeout.cancel(); });
    } catch (error) {
      finish({ slot: process.slot, code: 'apply_failed',
        detail: boundedError(error, 'worker drain waiter initialization failed') });
    }
  });
  return { result, fail };
}
