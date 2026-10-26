import { randomUUID } from 'node:crypto';
import { logger } from '../logger';
import { accessSync, constants, realpathSync } from 'node:fs';
import type { SystemUpdateStatus, UpdateOperation } from '@jeffusion/bungee-types';
import { readControlJson } from '../master-runtime/control-api-body';
import { installedExecutable, requestUpdateStop, selectedVersion, UpdateStore } from './installation';
import { activateStaged, stageRelease } from './download';
import { compareVersions, fetchLatestRelease, parseVersion, UpdateError, type UpdateRelease } from './release';

export type UpdateRequest = { operation_id: string; current_version: string; target_version: string; force?: boolean };
function validateRequest(input: UpdateRequest): void {
  if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['operation_id','current_version','target_version','force'].includes(key))
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.operation_id)
    || (input.force !== undefined && typeof input.force !== 'boolean')) throw new UpdateError('invalid_request', 400);
  parseVersion(input.current_version); parseVersion(input.target_version);
}
export type UpdateControllerOptions = {
  version: string;
  root?: string;
  compiled: boolean;
  offline?: boolean;
  platform?: NodeJS.Platform;
  executable?: string;
  http?: typeof fetch;
  admit?: () => Promise<void>;
  publicOrigin?: string;
  restart?: (activate: () => string, token: string, signal: AbortSignal) => Promise<void>;
};

export class UpdateController {
  private release: UpdateRelease | null = null;
  private checkedAt: number | null = null;
  private checkError: string | null = null;
  private checking: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly store: UpdateStore | null;
  private readonly unavailable: string | null;
  private cancellation: AbortController | null = null;
  private stopped = false;
  private flight: Promise<void> | null = null;
  private confirmation: { id: string; token: string; resolve(): void; confirmed: boolean } | null = null;
  private pendingRequest: { input: UpdateRequest; result: Promise<SystemUpdateStatus> } | null = null;
  private readonly http: typeof fetch;
  private storageFailed = false;

  constructor(private readonly options: UpdateControllerOptions) {
    parseVersion(options.version);
    this.http = options.http ?? fetch;
    this.store = null;
    this.unavailable = null;
    const platform = options.platform ?? process.platform;
    if (!options.offline && platform !== 'linux' && platform !== 'darwin') this.unavailable = 'windows_runtime';
    else if (!options.offline && !options.compiled) this.unavailable = 'source_runtime';
    else if (!options.root) this.unavailable = 'install_unavailable';
    else {
      try {
        const store = new UpdateStore(options.root);
        if (!options.offline && installedExecutable(store.root) !== realpathSync(options.executable ?? process.execPath)) throw new UpdateError('install_unavailable');
        accessSync(store.root, constants.W_OK);
        this.store = store;
      } catch (error) { this.unavailable = (error as NodeJS.ErrnoException).code === 'EACCES' ? 'not_writable' : 'install_unavailable'; }
    }
  }

  startChecking(): void {
    if (this.timer || this.stopped) return;
    void this.check();
    this.timer = setInterval(() => { void this.check(); }, 6 * 60 * 60 * 1000);
    this.timer.unref?.();
  }
  stopChecking(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
  cancel(): void {
    this.stopped = true; this.stopChecking();
    this.cancellation?.abort(new UpdateError('update_cancelled'));
    try { if (this.store) requestUpdateStop(this.store.root); }
    catch { this.storageFailed = true; logger.error({ code: 'update_stop_record_failed' }, 'Update cancellation record could not be persisted'); }
  }

  async check(): Promise<void> {
    if (this.checking) return this.checking;
    this.checking = (async () => {
      try { this.release = await fetchLatestRelease(this.http); this.checkError = null; }
      catch (error) { this.checkError = error instanceof UpdateError ? error.code : 'release_check_failed'; }
      finally { this.checkedAt = Date.now(); this.checking = null; }
    })();
    return this.checking;
  }

  status(operation?: UpdateOperation): SystemUpdateStatus {
    let selected: string | null = null, current = operation ?? null, reason = this.unavailable;
    try {
      selected = this.store ? selectedVersion(this.store.root) : null;
      current ??= this.store?.read() ?? null;
      if (this.store?.owner()) reason ??= 'update_busy';
    } catch { reason = 'install_unavailable'; }
    if (this.storageFailed) reason = 'install_unavailable';
    if (!reason && this.stopped) reason = 'update_cancelled';
    if (!reason && this.release && !this.release.asset) reason = 'asset_not_ready';
    const latest = this.release && { version: this.release.version, published_at: this.release.published_at,
      url: this.release.url, asset_ready: this.release.asset !== null };
    return { running_version: this.options.version, selected_version: selected, latest, checked_at: this.checkedAt,
      check_error: this.checkError, checking: this.checking !== null, unavailable_reason: reason,
      can_upgrade: !reason && !this.checkError && !!this.release?.asset && compareVersions(this.release.version, this.options.version) > 0,
      operation: current };
  }

  async request(input: UpdateRequest, requireConfirmation = false): Promise<SystemUpdateStatus> {
    validateRequest(input);
    if (this.pendingRequest) {
      const prior = this.pendingRequest.input;
      if (prior.operation_id !== input.operation_id) throw new UpdateError('update_busy', 409);
      if (prior.current_version !== input.current_version || prior.target_version !== input.target_version || prior.force !== input.force) throw new UpdateError('version_conflict', 409);
      return this.pendingRequest.result;
    }
    const result = this.accept(input, requireConfirmation);
    this.pendingRequest = { input: { ...input }, result };
    try { return await result; }
    finally { this.pendingRequest = null; }
  }

  confirm(input: UpdateRequest): SystemUpdateStatus {
    validateRequest(input);
    const operation = this.store?.read(input.operation_id);
    if (!operation || operation.source_version !== input.current_version || operation.target_version !== input.target_version) throw new UpdateError('version_conflict', 409);
    if (['stopping','restarting','succeeded','failed','cancelled'].includes(operation.phase)) return this.status(operation);
    const confirmation = this.confirmation;
    if (operation.phase !== 'awaiting_confirmation' || confirmation?.id !== input.operation_id) throw new UpdateError('update_not_ready', 409);
    if (this.stopped || this.cancellation?.signal.aborted || this.store!.stopRequested(confirmation.token)) throw new UpdateError('update_cancelled', 409);
    const owner = this.store!.owner();
    if (owner?.token !== confirmation.token || owner.pid !== process.pid) throw new UpdateError('update_owner_changed', 409);
    if (!confirmation.confirmed) { confirmation.confirmed = true; confirmation.resolve(); }
    return this.status(operation);
  }

  private async accept(input: UpdateRequest, requireConfirmation: boolean): Promise<SystemUpdateStatus> {
    if (!this.store || this.unavailable) throw new UpdateError(this.unavailable ?? 'install_unavailable');
    const previous = this.store.read(input.operation_id);
    if (previous) {
      if (previous.source_version !== input.current_version || previous.target_version !== input.target_version) throw new UpdateError('version_conflict', 409);
      return this.status(previous);
    }
    if (this.stopped) throw new UpdateError('update_cancelled', 409);
    if (input.current_version !== this.options.version) throw new UpdateError('version_conflict', 409);
    if (!this.release || this.checkError) await this.check();
    if (this.stopped) throw new UpdateError('update_cancelled', 409);
    if (this.checkError || !this.release) throw new UpdateError(this.checkError ?? 'release_check_failed', 503);
    if (this.release.version !== input.target_version || compareVersions(input.target_version, input.current_version) < 0
      || (input.target_version === input.current_version && !input.force)) throw new UpdateError('version_conflict', 409);
    if (!this.release.asset) throw new UpdateError('asset_not_ready');
    const token = randomUUID();
    try { this.store.acquire(token); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new UpdateError('update_busy', 409); throw error; }
    const now = Date.now();
    const operation: UpdateOperation = { id: input.operation_id, source_version: input.current_version,
      target_version: input.target_version, phase: 'downloading', error: null, started_at: now, updated_at: now };
    this.cancellation = new AbortController();
    try {
      await this.options.admit?.();
      if (this.stopped || this.cancellation.signal.aborted || this.store.stopRequested(token)) throw new UpdateError('update_cancelled', 409);
      this.store.write(operation);
    } catch (error) { this.store.release(token); this.cancellation = null; throw error; }
    const release = this.release;
    this.flight = new Promise<void>(resolve => setTimeout(resolve, 0)).then(() => this.perform(operation, release, token, requireConfirmation)).catch(() => {
      this.storageFailed = true;
      logger.error({ code: 'update_record_failed' }, 'Update result could not be persisted; operation ownership retained');
    });
    return this.status();
  }

  private async perform(operation: UpdateOperation, release: UpdateRelease, token: string, requireConfirmation: boolean): Promise<void> {
    const store = this.store!, signal = this.cancellation!.signal;
    const keepAlive = setInterval(() => {}, 1000);
    const phase = (value: UpdateOperation['phase'], error: string | null = null) => {
      operation = { ...operation, phase: value, error, updated_at: Date.now() }; store.write(operation);
    };
    let staged: Awaited<ReturnType<typeof stageRelease>> | null = null;
    try {
      staged = await stageRelease(store.root, release, signal, () => phase('verifying'), this.http);
      signal.throwIfAborted();
      if (requireConfirmation) {
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(signal.reason);
          this.confirmation = { id: operation.id, token, confirmed: false,
            resolve: () => { signal.removeEventListener('abort', abort); resolve(); } };
          signal.addEventListener('abort', abort, { once: true });
          try { signal.throwIfAborted(); phase('awaiting_confirmation'); }
          catch (error) { signal.removeEventListener('abort', abort); reject(error); }
        });
        this.confirmation = null;
        signal.throwIfAborted();
      }
      const activate = () => {
        signal.throwIfAborted();
        if (store.stopRequested(token)) throw new UpdateError('update_cancelled');
        const owner = store.owner();
        if (owner?.token !== token || owner.pid !== process.pid) throw new UpdateError('update_owner_changed', 409);
        const executable = activateStaged(store.root, release, staged!);
        store.select(release.version);
        phase('restarting');
        return executable;
      };
      if (this.options.restart) { phase('stopping'); await this.options.restart(activate, token, signal); }
      else { activate(); phase('succeeded'); store.release(token); }
    } catch (error) {
      if (!(error instanceof UpdateError) && !signal.aborted) logger.warn({
        name: error instanceof Error ? error.name : 'unknown',
        code: (error as NodeJS.ErrnoException)?.code ?? null,
        message: error instanceof Error ? error.message.slice(0, 512) : 'Update failed',
      }, 'Update operation failed');
      const code = signal.aborted ? 'update_cancelled' : error instanceof UpdateError ? error.code
        : operation.phase === 'stopping' ? 'shutdown_failed' : operation.phase === 'restarting' ? 'startup_failed'
        : operation.phase === 'verifying' ? 'verification_failed' : 'download_failed';
      try { phase(signal.aborted ? 'cancelled' : 'failed', code); }
      finally { if (store.owner()?.token === token) store.release(token); }
    } finally { clearInterval(keepAlive); staged?.dispose(); this.cancellation = null; this.confirmation = null; }
  }

  async wait(): Promise<SystemUpdateStatus> { await this.flight; return this.status(); }

  async completeStartup(token: string | undefined, ready: () => boolean): Promise<void> {
    if (!token || !this.store) return;
    const owner = this.store.owner(), operation = this.store.read();
    if (!owner || owner.token !== token || owner.pid !== process.pid || operation?.phase !== 'restarting'
      || operation.target_version !== this.options.version) throw new UpdateError('update_owner_changed', 409);
    const deadline = performance.now() + 30_000;
    while (!ready() && !this.stopped && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 200));
    this.store.write({ ...operation, phase: ready() && !this.stopped ? 'succeeded' : 'failed',
      error: ready() && !this.stopped ? null : 'startup_failed', updated_at: Date.now() });
    this.store.release(token);
  }

  async handle(request: Request, privateControl = false): Promise<Response> {
    const path = new URL(request.url).pathname;
    const headers = { 'cache-control': 'no-store' };
    try {
      if (request.method === 'GET' && !path.endsWith('/check') && !path.endsWith('/confirm')) return Response.json(this.status(), { headers });
      if (request.method !== 'POST') return Response.json({ error: 'method_not_allowed' }, { status: 405, headers });
      if (!privateControl && request.headers.get('origin') !== (this.options.publicOrigin ?? new URL(request.url).origin)) throw new UpdateError('invalid_origin', 403);
      if (path.endsWith('/check')) { await this.check(); return Response.json(this.status(), { headers }); }
      const body = await readControlJson(request);
      if (!body.ok) return Response.json({ error: body.error }, { status: body.status, headers });
      return Response.json(path.endsWith('/confirm') ? this.confirm(body.value as UpdateRequest)
        : await this.request(body.value as UpdateRequest, !privateControl), { status: 202, headers });
    } catch (error) {
      if (error instanceof UpdateError) return Response.json({ error: error.code }, { status: error.status, headers });
      return Response.json({ error: 'install_unavailable' }, { status: 503, headers });
    }
  }
}
