const CODEX_MODELS_URL = 'https://chatgpt.com/backend-api/codex/models';
const CODEX_ORIGINATOR = 'codex_cli_rs';
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_MAX_MODELS = 256;
const DEFAULT_MAX_CACHE_ENTRIES = 32;

export type CodexModelsErrorKind =
  | 'invalid_identity'
  | 'aborted'
  | 'timeout'
  | 'network'
  | 'http'
  | 'invalid_content_type'
  | 'body_limit'
  | 'invalid_json'
  | 'invalid_structure';

export class CodexModelsError extends Error {
  readonly name = 'CodexModelsError';

  constructor(readonly kind: CodexModelsErrorKind, readonly status?: number) {
    super(status === undefined ? kind : `${kind}:${status}`);
  }
}

export interface CodexModelDescriptor {
  readonly id: string;
  readonly source: 'static' | 'upstream';
  readonly sourceRef: string;
  readonly displayName?: string;
  readonly capabilities?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface CodexModelSource {
  readonly kind: 'static' | 'upstream';
  readonly sourceRef: string;
  load(signal?: AbortSignal): Promise<readonly CodexModelDescriptor[]>;
}

export interface CodexModelIdentity {
  readonly accountId: string;
  readonly generation: number;
  /** Must be the real client version supplied by the caller. */
  readonly clientVersion: string;
}

export interface CodexModelsRequestOptions {
  readonly etag?: string;
}

export interface CodexModelsRequest {
  readonly url: string;
  readonly init: RequestInit;
}

export type CodexModelsExecute = (request: CodexModelsRequest, signal: AbortSignal) => Promise<Response>;

export interface CodexModelSnapshot {
  readonly models: readonly CodexModelDescriptor[];
  readonly source: 'upstream';
  readonly etag?: string;
  readonly fetchedAt: number;
  readonly stale: false;
}

export interface CodexModelSourceOptions {
  readonly identity: CodexModelIdentity;
  readonly execute: CodexModelsExecute;
  readonly cache?: CodexModelCache;
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly timeoutMs?: number;
  readonly maxBodyBytes?: number;
  readonly maxModels?: number;
}

function text(value: unknown, max = 512): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value
    && !/[\r\n\u0000]/.test(value);
}

function assertIdentity(identity: CodexModelIdentity): void {
  if (!text(identity.accountId) || !text(identity.clientVersion)
    || !Number.isSafeInteger(identity.generation) || identity.generation < 1) {
    throw new CodexModelsError('invalid_identity');
  }
}

/** Pure request builder. Credentials are deliberately supplied by the injected executor, not this interface. */
export function buildCodexModelsRequest(
  clientVersion: string,
  options: CodexModelsRequestOptions = {},
): CodexModelsRequest {
  if (!text(clientVersion)) throw new CodexModelsError('invalid_identity');
  const headers = new Headers({ Accept: 'application/json', Originator: CODEX_ORIGINATOR });
  if (text(options.etag)) headers.set('If-None-Match', options.etag);
  return {
    url: `${CODEX_MODELS_URL}?client_version=${encodeURIComponent(clientVersion)}`,
    init: { method: 'GET', headers, redirect: 'manual' },
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (!text(value)) throw new CodexModelsError('invalid_structure');
  return value;
}

/** Parses the official envelope without inventing OpenAI metadata. */
export function parseCodexModelsPayload(value: unknown, maxModels = DEFAULT_MAX_MODELS): readonly CodexModelDescriptor[] {
  if (!object(value) || !Array.isArray(value.models) || value.models.length > maxModels) {
    throw new CodexModelsError('invalid_structure');
  }

  const models: CodexModelDescriptor[] = [];
  for (const item of value.models) {
    if (!object(item) || !text(item.slug)) throw new CodexModelsError('invalid_structure');
    const visibility = item.visibility === undefined ? 'list' : item.visibility;
    const supportedInApi = item.supported_in_api === undefined ? false : item.supported_in_api;
    if (typeof visibility !== 'string' || typeof supportedInApi !== 'boolean') {
      throw new CodexModelsError('invalid_structure');
    }
    const displayName = optionalString(item.display_name);
    optionalString(item.minimal_client_version);
    if (visibility !== 'list' || supportedInApi !== true) continue;
    models.push({
      id: item.slug,
      source: 'upstream',
      sourceRef: CODEX_MODELS_URL,
      ...(displayName === undefined ? {} : { displayName }),
      metadata: item,
    });
  }
  return models;
}

export function parseCodexModelsBody(
  body: string,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  maxModels = DEFAULT_MAX_MODELS,
): readonly CodexModelDescriptor[] {
  if (new TextEncoder().encode(body).byteLength > maxBodyBytes) throw new CodexModelsError('body_limit');
  let value: unknown;
  try {
    value = JSON.parse(body) as unknown;
  } catch {
    throw new CodexModelsError('invalid_json');
  }
  return parseCodexModelsPayload(value, maxModels);
}

export function codexModelsCacheKey(identity: CodexModelIdentity): string {
  assertIdentity(identity);
  return [identity.accountId, identity.generation, identity.clientVersion, CODEX_ORIGINATOR]
    .map((part) => encodeURIComponent(String(part))).join('|');
}

interface CacheEntry {
  readonly snapshot: CodexModelSnapshot;
  readonly expiresAt: number;
  readonly touchedAt: number;
}

export class CodexModelCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly epochs = new Map<string, number>();

  constructor(private readonly maxEntries = DEFAULT_MAX_CACHE_ENTRIES) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > DEFAULT_MAX_CACHE_ENTRIES) {
      throw new RangeError('invalid Codex model cache size');
    }
  }

  get(key: string): CacheEntry | undefined { return this.entries.get(key); }

  epoch(key: string): number { return this.epochs.get(key) ?? 0; }

  set(key: string, snapshot: CodexModelSnapshot, expiresAt: number, touchedAt: number, expectedEpoch = this.epoch(key)): boolean {
    if (this.epoch(key) !== expectedEpoch) return false;
    if (!this.entries.has(key) && this.entries.size >= this.maxEntries) {
      const oldest = [...this.entries.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0];
      if (oldest) this.entries.delete(oldest[0]);
    }
    this.entries.set(key, { snapshot, expiresAt, touchedAt });
    return true;
  }

  invalidate(key: string, etag?: string): boolean {
    const entry = this.entries.get(key);
    const invalidated = entry !== undefined && (etag === undefined || entry.snapshot.etag === etag);
    if (invalidated) this.entries.delete(key);
    this.epochs.set(key, this.epoch(key) + 1);
    return invalidated;
  }
}

function cancelResponseBody(response: Response): void {
  if (response.body !== null) void response.body.cancel().catch(() => undefined);
}

function isJsonContentType(response: Response): boolean {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  return contentType === 'application/json' || contentType?.endsWith('+json') === true;
}

async function readBoundedBody(response: Response, maxBodyBytes: number, timeoutMs: number, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw new CodexModelsError('aborted');
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let bytes = 0;
  let body = '';
  let releaseReader = true;
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new CodexModelsError('timeout');
      const part = await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new CodexModelsError('timeout')), remaining);
        const onAbort = () => reject(new CodexModelsError('aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
        reader.read().then(resolve, reject).finally(() => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
        });
      });
      if (part.done) return body + decoder.decode();
      bytes += part.value.byteLength;
      if (bytes > maxBodyBytes) throw new CodexModelsError('body_limit');
      body += decoder.decode(part.value, { stream: true });
    }
  } catch (error) {
    releaseReader = false;
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    if (releaseReader) reader.releaseLock();
  }
}

async function executeWithDeadline(
  execute: CodexModelsExecute,
  request: CodexModelsRequest,
  timeoutMs: number,
  parentSignal: AbortSignal,
): Promise<Response> {
  if (parentSignal.aborted) throw new CodexModelsError('aborted');
  const controller = new AbortController();
  let rejectAbort: (() => void) | undefined;
  const abortPromise = new Promise<Response>((_, reject) => {
    rejectAbort = () => reject(new CodexModelsError('aborted'));
  });
  const onAbort = () => {
    controller.abort();
    rejectAbort?.();
  };
  parentSignal.addEventListener('abort', onAbort, { once: true });
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const responsePromise = Promise.resolve().then(() => execute(request, controller.signal));
  responsePromise.then((response) => {
    if (settled) cancelResponseBody(response);
  }, () => undefined);
  try {
    const timeoutPromise = new Promise<Response>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        controller.abort();
        reject(new CodexModelsError('timeout'));
      }, timeoutMs);
    });
    return await Promise.race([responsePromise, timeoutPromise, abortPromise]);
  } catch (error) {
    if (error instanceof CodexModelsError) throw error;
    if (parentSignal.aborted) throw new CodexModelsError('aborted');
    throw new CodexModelsError('network');
  } finally {
    settled = true;
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    parentSignal.removeEventListener('abort', onAbort);
  }
}

export class DynamicCodexModelSource implements CodexModelSource {
  readonly kind = 'upstream' as const;
  readonly sourceRef = CODEX_MODELS_URL;
  private readonly cache: CodexModelCache;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly maxBodyBytes: number;
  private readonly maxModels: number;
  constructor(private readonly identity: CodexModelIdentity, private readonly options: Omit<CodexModelSourceOptions, 'identity'>) {
    assertIdentity(identity);
    this.cache = options.cache ?? new CodexModelCache();
    this.now = options.now ?? Date.now;
    this.ttlMs = Math.min(options.ttlMs ?? DEFAULT_TTL_MS, DEFAULT_TTL_MS);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBodyBytes = Math.min(options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES);
    this.maxModels = Math.min(options.maxModels ?? DEFAULT_MAX_MODELS, DEFAULT_MAX_MODELS);
    if (![this.ttlMs, this.timeoutMs, this.maxBodyBytes, this.maxModels].every((value) => Number.isFinite(value) && value > 0)) {
      throw new RangeError('invalid Codex model source limits');
    }
  }

  async load(signal?: AbortSignal): Promise<readonly CodexModelDescriptor[]> {
    return (await this.loadSnapshot(signal)).models;
  }

  async loadSnapshot(signal?: AbortSignal): Promise<CodexModelSnapshot> {
    if (signal?.aborted) throw new CodexModelsError('aborted');
    const key = codexModelsCacheKey(this.identity);
    const cached = this.cache.get(key);
    const now = this.now();
    if (cached !== undefined && cached.expiresAt > now) return cached.snapshot;

    const epoch = this.cache.epoch(key);
    const request = buildCodexModelsRequest(this.identity.clientVersion, { etag: cached?.snapshot.etag });
    try {
      const response = await executeWithDeadline(this.options.execute, request, this.timeoutMs, signal ?? new AbortController().signal);
      if (response.status === 304) {
        if (cached === undefined) {
          cancelResponseBody(response);
          throw new CodexModelsError('http', 304);
        }
        const snapshot: CodexModelSnapshot = { ...cached.snapshot, fetchedAt: now, stale: false };
        this.cache.set(key, snapshot, now + this.ttlMs, now, epoch);
        return snapshot;
      }
      if (!response.ok) {
        cancelResponseBody(response);
        if (response.status === 401 || response.status === 403) {
          this.cache.invalidate(key);
          throw new CodexModelsError('network', response.status);
        }
        throw new CodexModelsError('http', response.status);
      }
      if (!isJsonContentType(response)) {
        cancelResponseBody(response);
        throw new CodexModelsError('invalid_content_type');
      }
      const models = parseCodexModelsBody(await readBoundedBody(response, this.maxBodyBytes, this.timeoutMs, signal ?? new AbortController().signal), this.maxBodyBytes, this.maxModels);
      const etag = response.headers.get('etag') ?? undefined;
      const snapshot: CodexModelSnapshot = { models, source: 'upstream', ...(etag === undefined ? {} : { etag }), fetchedAt: now, stale: false };
      this.cache.set(key, snapshot, now + this.ttlMs, now, epoch);
      return snapshot;
    } catch (error) {
      if (error instanceof CodexModelsError) throw error;
      throw new CodexModelsError('network');
    }
  }

  invalidate(etag?: string): void {
    this.cache.invalidate(codexModelsCacheKey(this.identity), etag);
  }

}

export function createCodexModelSource(options: CodexModelSourceOptions): DynamicCodexModelSource {
  return new DynamicCodexModelSource(options.identity, options);
}

export class CodexModelCatalog {
  constructor(private readonly source: CodexModelSource) {}

  async list(signal?: AbortSignal): Promise<readonly CodexModelDescriptor[]> {
    const models = await this.source.load(signal);
    return models.map((model) => ({ ...model, source: this.source.kind, sourceRef: this.source.sourceRef }));
  }
}
