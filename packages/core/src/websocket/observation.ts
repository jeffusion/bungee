import type { PluginHooks } from '../hooks';
import type { WebSocketObservationEvent, WebSocketSessionContext } from '../gateway/websocket-contracts';

type Detail = WebSocketObservationEvent extends infer E ? E extends WebSocketObservationEvent ? Omit<E, keyof WebSocketSessionContext | 'isActive'> : never : never;
type Owner = { pluginName: string; hooks: PluginHooks['onWebSocketObservation'] };
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_PROCESS_BYTES = 64 * 1024 * 1024;
const MAX_MESSAGES = 64;
const DEADLINE_MS = 250;
let processBytes = 0;

/** Independent, ordered queues: an optional observer cannot block forwarding or another owner. */
export class WebSocketObservers {
  private branches: Branch[];
  constructor(context: WebSocketSessionContext, owners: readonly Owner[]) {
    this.branches = owners.filter(owner=>owner.hooks.hasCallbacks()).map(owner => new Branch(context, owner));
  }
  emit(detail: Detail): void { for (const branch of this.branches) branch.push(detail); }
  async close(detail: Extract<Detail, {phase:'close'}>): Promise<void> {
    this.emit(detail);
    await Promise.all(this.branches.map(branch => branch.closeDrain()));
  }
}
class Branch {
  private queue: Detail[] = [];
  private bytes = 0;
  private running: Promise<void> | undefined;
  private disabled = false;
  constructor(private context: WebSocketSessionContext, private owner: Owner) {}
  push(detail: Detail): void {
    if (this.disabled && detail.phase !== 'close') return;
    const bytes = detail.phase === 'message' ? detail.message.byteLength : 0;
    if (detail.phase === 'message' && (this.queue.length >= MAX_MESSAGES || this.bytes + bytes > MAX_BYTES || processBytes + bytes > MAX_PROCESS_BYTES)) {
      this.fail('buffer-limit');
      return;
    }
    this.queue.push(detail); this.bytes += bytes; processBytes += bytes;
    this.kick();
  }
  private fail(reason: Extract<Detail,{phase:'incomplete'}>['reason']): void {
    if (this.disabled) return;
    this.disabled = true;
    const terminal = this.queue.find(detail=>detail.phase==='close');
    this.drop();
    this.queue.push({phase:'incomplete',reason});
    if (terminal) this.queue.push(terminal);
    this.kick();
  }
  private drop(): void {
    // In-flight delivery stays accounted until its lease expires.
    for (const detail of this.queue) if (detail.phase === 'message') {
      this.bytes -= detail.message.byteLength; processBytes -= detail.message.byteLength;
    }
    this.queue.length = 0;
  }
  private kick(): void {
    if (this.running) return;
    this.running = this.run().finally(() => { this.running = undefined; if (this.queue.length) this.kick(); });
  }
  private async run(): Promise<void> {
    while (this.queue.length) {
      const detail = this.queue.shift()!;
      let active = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const event = Object.freeze({...this.context,...detail,isActive:()=>active}) as WebSocketObservationEvent;
      const outcome = await Promise.race([
        Promise.resolve().then(() => this.owner.hooks.promise(event)).then(()=>'ok' as const,()=> 'observer-error' as const),
        new Promise<'observer-timeout'>(resolve => {timer = setTimeout(()=>{active=false;resolve('observer-timeout');},DEADLINE_MS);}),
      ]);
      active = false; clearTimeout(timer);
      if (detail.phase === 'message') { this.bytes -= detail.message.byteLength; processBytes -= detail.message.byteLength; }
      if (outcome !== 'ok' && detail.phase !== 'incomplete' && detail.phase !== 'close') this.fail(outcome);
    }
  }
  async closeDrain(): Promise<void> {
    const timer=setTimeout(()=>this.fail('observer-timeout'),500);
    try {await this.done();} finally {clearTimeout(timer);}
  }
  async done(): Promise<void> { while (this.running) await this.running; }
}
