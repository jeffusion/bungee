import type {
  ConfigPublicationWorkerProcess,
  ScheduledTimeout,
} from '../config-publication/coordinator-types';
import { bestEffort } from '../config-publication/waiter-safety';

export interface HeartbeatIntervalScheduler {
  scheduleEvery(intervalMs: number, callback: () => void): ScheduledTimeout;
}

export type MasterHeartbeatSenderOptions = {
  readonly masterPid: number;
  readonly intervalMs: number;
  readonly scheduler?: HeartbeatIntervalScheduler;
};

type HeartbeatEntry = {
  readonly process: ConfigPublicationWorkerProcess;
  interval: ScheduledTimeout;
  unsubscribeExit: () => void;
  sequence: number;
  active: boolean;
  sending: boolean;
};

const INTERVAL_SCHEDULER: HeartbeatIntervalScheduler = {
  scheduleEvery(intervalMs, callback) {
    const interval = setInterval(callback, intervalMs);
    return { cancel: () => { clearInterval(interval); } };
  },
};

export class MasterHeartbeatSender {
  private readonly entries = new Map<ConfigPublicationWorkerProcess, HeartbeatEntry>();
  private readonly masterPid: number;
  private readonly intervalMs: number;
  private readonly scheduler: HeartbeatIntervalScheduler;

  constructor(options: MasterHeartbeatSenderOptions) {
    if (!Number.isSafeInteger(options.masterPid) || options.masterPid <= 0) {
      throw new TypeError('master heartbeat pid must be a positive safe integer');
    }
    if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs <= 0) {
      throw new TypeError('master heartbeat interval must be a positive safe integer');
    }
    this.masterPid = options.masterPid;
    this.intervalMs = options.intervalMs;
    this.scheduler = options.scheduler ?? INTERVAL_SCHEDULER;
  }

  start(process: ConfigPublicationWorkerProcess): void {
    if (this.entries.has(process)) return;
    const entry: HeartbeatEntry = {
      process,
      interval: { cancel: () => undefined },
      unsubscribeExit: () => undefined,
      sequence: 0,
      active: true,
      sending: false,
    };
    this.entries.set(process, entry);
    try {
      const unsubscribeExit = process.subscribeExit((evidence) => {
        if (evidence.pid === process.pid) this.stop(process);
      });
      if (!entry.active) {
        bestEffort(unsubscribeExit);
        return;
      }
      entry.unsubscribeExit = unsubscribeExit;
      entry.interval = this.scheduler.scheduleEvery(this.intervalMs, () => {
        void this.send(entry);
      });
    } catch (error) {
      this.stop(process);
      throw error;
    }
    void this.send(entry);
  }

  stop(process: ConfigPublicationWorkerProcess): void {
    const entry = this.entries.get(process);
    if (entry === undefined) return;
    entry.active = false;
    this.entries.delete(process);
    bestEffort(() => { entry.interval.cancel(); });
    bestEffort(entry.unsubscribeExit);
  }

  stopAll(): void {
    for (const process of [...this.entries.keys()]) this.stop(process);
  }

  private async send(entry: HeartbeatEntry): Promise<void> {
    if (!entry.active || entry.sending) return;
    entry.sending = true;
    entry.sequence += 1;
    await new Promise<void>((resolve) => {
      resolve(entry.process.send({
        command: 'master-heartbeat',
        ...entry.process.identity,
        master_pid: this.masterPid,
        sequence: entry.sequence,
      }));
    }).catch(() => undefined);
    entry.sending = false;
  }
}
