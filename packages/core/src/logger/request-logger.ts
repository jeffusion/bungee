import { accessLogWriter, type ProcessingStep } from './access-log-writer';
import { fileLogWriter, type FileLogEntry } from './file-log-writer';
import type { AccessLogWriter } from './access-log-writer';
import type { FileLogWriter } from './file-log-writer';
import type { BodyStorageManager } from './body-storage';
import type { HeaderStorageManager } from './header-storage';
import type { RawResponseError } from '../plugin-control/contracts';
import type { TransportOutcome } from './transport-outcome';
import { captureBody, trackBodyLogTask, type BodyCapture } from './body-capture';

type BodyType = 'request' | 'response' | 'original-request';

function diagnosticMessage(error?: RawResponseError): string | undefined {
  if (!error) return undefined;
  const kind = [error.code, error.type].filter(Boolean).join(' / ');
  return `[${error.source}] ${kind ? `${kind}: ` : ''}${error.message}`;
}

export type RequestLoggerDependencies = {
  readonly accessLogWriter?: Pick<AccessLogWriter, 'write' | 'updateResponseBodyId' | 'updateProtocolOutcome'>
    & Partial<Pick<AccessLogWriter, 'updateTransportOutcome' | 'updateBodyId' | 'appendProcessingStep'>>;
  readonly fileLogWriter?: Pick<FileLogWriter, 'write'>;
  readonly bodyStorage?: Pick<BodyStorageManager, 'save'> & Partial<Pick<BodyStorageManager, 'getConfig'>>;
  readonly headerStorage?: Pick<HeaderStorageManager, 'save'>;
};

export interface FailoverAttemptOptions {
  isFailoverAttempt?: boolean;   // 是否是故障转移尝试
  parentRequestId?: string;      // 父请求 ID
  attemptNumber?: number;        // 尝试序号
  attemptUpstream?: string;      // 尝试的上游地址
  requestType?: 'final' | 'retry' | 'recovery';  // 请求类型分类
}

export interface RequestLogCompletionOptions {
  routePath?: string;
  upstream?: string;
  transformer?: string;
  authSuccess?: boolean;
  authLevel?: string;
  errorMessage?: string;
  protocolOutcome?: 'completed' | 'failed' | 'incomplete' | 'cancelled';
  protocolCode?: string;
  transportOutcome?: TransportOutcome;
  transportCode?: string;
  success?: boolean;
  protocolError?: RawResponseError;
}

/**
 * 请求日志记录器
 *
 * 用于在请求处理过程中收集日志信息：
 * - 请求基本信息（method, path, status, duration）
 * - 业务信息（route, upstream, transformer）
 * - 处理步骤（path rewrite, body transformation, auth）
 * - 错误信息
 * - 请求/响应体（可选）
 *
 * 使用方式：
 * ```typescript
 * const reqLogger = new RequestLogger(req);
 * reqLogger.setRequestBody(requestBody);
 * reqLogger.addStep('auth', { success: true });
 * reqLogger.addStep('transformer', { name: 'openai-to-anthropic' });
 * reqLogger.setResponseBody(responseBody);
 * await reqLogger.complete(response.status, { routePath, upstream, transformer });
 * ```
 */
export class RequestLogger {
  private requestId: string;
  private startTime: number;
  private method: string;
  private path: string;
  private query: string;
  private transformedPath: string | null = null;  // 转换后的路径（经过 pathRewrite）
  private steps: ProcessingStep[] = [];
  private requestBody: any = null;
  private responseBody: any = null;
  private requestHeaders: Record<string, string> | null = null;
  private responseHeaders: Record<string, string> | null = null;
  private originalRequestHeaders: Record<string, string> | null = null;
  private originalRequestBody: any = null;
  // 故障转移相关字段
  private isFailoverAttempt: boolean = false;
  private parentRequestId: string | null = null;
  private attemptNumber: number | null = null;
  private attemptUpstream: string | null = null;
  private requestType: 'final' | 'retry' | 'recovery' = 'final';
  private rootPersisted = false;
  private completed = false;
  private completionPromise: Promise<void> | null = null;
  private fileLogEntry: FileLogEntry | null = null;
  private fileLogWritten = false;
  private protocolError?: RawResponseError;
  private transportOutcome: TransportOutcome = 'unknown';
  private transportCode?: string;
  private transportStarted = false;
  private clientTransportObserved = false;
  private deferTransportFileLog = false;
  private fileLogWritePromise: Promise<void> | null = null;
  private readonly bodyCaptures = new Map<BodyType, BodyCapture>();
  private readonly capturedTypes = new Set<BodyType>();
  private readonly capturedIds = new Map<BodyType, string>();
  private readonly captureVersions = new Map<BodyType, number>();
  private readonly inheritedBodyCompletions = new Set<Promise<void>>();
  private fileLogTask?: Promise<void>;
  private fileLogReady?: Promise<void>;
  private readonly dependencies: Required<Pick<RequestLoggerDependencies, 'accessLogWriter' | 'fileLogWriter'>>
    & Omit<RequestLoggerDependencies, 'accessLogWriter' | 'fileLogWriter'>;
  private requestAccept = '';

  constructor(
    req: Request,
    failoverOptions?: FailoverAttemptOptions,
    dependencies: RequestLoggerDependencies = {},
  ) {
    this.dependencies = {
      accessLogWriter: dependencies.accessLogWriter ?? accessLogWriter,
      fileLogWriter: dependencies.fileLogWriter ?? fileLogWriter,
      bodyStorage: dependencies.bodyStorage,
      headerStorage: dependencies.headerStorage,
    };
    this.requestId = crypto.randomUUID();
    this.startTime = Date.now();
    const url = new URL(req.url);
    this.method = req.method;
    this.path = url.pathname;
    this.query = url.search;
    this.requestAccept = req.headers.get('accept') ?? '';

    // 设置故障转移相关参数
    if (failoverOptions) {
      this.isFailoverAttempt = failoverOptions.isFailoverAttempt || false;
      this.parentRequestId = failoverOptions.parentRequestId || null;
      this.attemptNumber = failoverOptions.attemptNumber || null;
      this.attemptUpstream = failoverOptions.attemptUpstream || null;
      this.requestType = failoverOptions.requestType || 'final';
    }
  }

  /**
   * 添加处理步骤（无耗时信息，向后兼容）
   * @param step 步骤名称，如：'auth', 'path_rewrite', 'transformer', 'body_add'
   * @param detail 步骤详情
   */
  addStep(step: string, detail?: any) {
    const entry = {
      step,
      detail,
      timestamp: Date.now(),
    };
    this.steps.push(entry);
    if (this.completed) this.dependencies.accessLogWriter.appendProcessingStep?.(this.requestId, entry);
  }

  /** Record the actual representation independently of parsing, rewriting and plugin observers. */
  observeBody(body: BodyInit | null, type: BodyType, headers: Headers,
    config?: { enabled: boolean; max_size?: number }, signal?: AbortSignal, status = 200): BodyInit | null {
    const storage = this.dependencies.bodyStorage;
    if (!config?.enabled || !storage || body === null || this.capturedTypes.has(type)) return body;
    // Preserve error diagnostics above the ordinary log limit, with a hard bound.
    const isError = type === 'response' && status >= 400;
    const maxBytes = Math.min(isError ? 5 * 1024 * 1024 : config.max_size ?? storage.getConfig?.().maxSize ?? 5120, 5 * 1024 * 1024);
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return body;
    this.capturedTypes.add(type);
    const version = this.captureVersions.get(type) ?? 0;
    try {
      const source = body instanceof ReadableStream ? body : new Response(body).body!;
      const capture = captureBody(source, maxBytes, headers.get('content-encoding') ?? '', async value => {
        const serialized = typeof value === 'string' ? value : JSON.stringify(value);
        if (Buffer.byteLength(serialized) > maxBytes) {
          this.addStep('body_logging_incomplete', { direction: type, reason: 'size_limit', observer_incomplete: true });
          return;
        }
        let id: string | null;
        try { id = await storage.save(version ? `${this.requestId}-${version}` : this.requestId, value, type, isError); }
        catch {
          this.addStep('body_logging_incomplete', { direction: type, reason: 'storage_failed', observer_incomplete: true });
          return;
        }
        if (this.captureVersions.get(type) !== version && !(version === 0 && !this.captureVersions.has(type))) return;
        if (id) this.recordCapturedId(type, id);
        else this.addStep('body_logging_incomplete', { direction: type, reason: 'storage_failed', observer_incomplete: true });
      }, reason => this.addStep('body_logging_incomplete', { direction: type, reason, observer_incomplete: true }), signal, headers.get('content-type') ?? '', type === 'response' ? this.requestAccept : '');
      this.bodyCaptures.set(type, capture);
      return capture.body;
    } catch {
      this.addStep('body_logging_incomplete', { direction: type, reason: 'capture_failed', observer_incomplete: true });
      return body;
    }
  }

  private recordCapturedId(type: BodyType, id: string): void {
    this.capturedIds.set(type, id);
    if (this.fileLogEntry) {
      const field = { request: 'reqBodyId', response: 'respBodyId', 'original-request': 'originalReqBodyId' } as const;
      this.fileLogEntry[field[type]] = id;
    }
    if (!this.completed) return;
    try {
      const writer = this.dependencies.accessLogWriter;
      if (writer.updateBodyId) writer.updateBodyId(this.requestId, type, id);
      else if (type === 'response') writer.updateResponseBodyId(this.requestId, id);
    } catch { this.addStep('body_logging_incomplete', { direction: type, reason: 'storage_failed', observer_incomplete: true }); }
  }

  inheritOriginalBody(source: RequestLogger): void {
    const capture = source.bodyCaptures.get('original-request');
    if (!capture) return;
    this.capturedTypes.add('original-request');
    const completion = capture.completion.then(() => {
      const id = source.capturedIds.get('original-request');
      if (id) this.recordCapturedId('original-request', id);
      else {
        const failure = source.steps.find(step => step.step === 'body_logging_incomplete' && step.detail?.direction === 'original-request');
        this.addStep('body_logging_incomplete', failure?.detail ?? { direction: 'original-request', reason: 'capture_failed', observer_incomplete: true });
      }
    });
    this.inheritedBodyCompletions.add(completion);
  }

  async bodyLoggingCompletion(): Promise<void> {
    await Promise.all([...this.bodyCaptures.values()].map(capture => capture.completion).concat([...this.inheritedBodyCompletions]));
  }

  stopBodyLogging(): void {
    for (const capture of this.bodyCaptures.values()) capture.stop();
  }

  /** The handler can still replace a failed attempt's response until request cleanup. */
  deferFileLog(): () => void {
    let release!: () => void;
    this.fileLogReady = new Promise<void>(resolve => { release = resolve; });
    return release;
  }

  /** Route retries reuse one access record; only the current representation may update its IDs. */
  beginBodyLoggingAttempt(): void {
    for (const type of ['request', 'response'] as const) {
      this.resetBodyCapture(type);
    }
  }

  beginResponseBodyLogging(): void { this.resetBodyCapture('response'); }

  private resetBodyCapture(type: 'request' | 'response'): void {
    this.bodyCaptures.get(type)?.stop();
    this.bodyCaptures.delete(type);
    this.capturedTypes.delete(type);
    this.capturedIds.delete(type);
    this.captureVersions.set(type, (this.captureVersions.get(type) ?? 0) + 1);
  }

  /**
   * 添加处理步骤（带耗时信息）
   * @param step 步骤名称
   * @param duration 步骤耗时（毫秒）
   * @param detail 步骤详情
   */
  addStepWithDuration(step: string, duration: number, detail?: any) {
    this.steps.push({
      step,
      detail,
      timestamp: Date.now(),
      duration: Math.round(Math.max(0, duration) * 100) / 100, // 四舍五入到2位小数，确保非负
    });
  }

  /**
   * 测量并记录步骤耗时的辅助方法
   * @param step 步骤名称
   * @param fn 要执行的异步函数
   * @param detail 步骤详情（可选，也可以是返回详情的函数）
   * @returns 函数执行结果
   */
  async measureStep<T>(
    step: string,
    fn: () => Promise<T>,
    detail?: any | ((result: T) => any)
  ): Promise<T> {
    const startTime = performance.now();
    const result = await fn();
    const duration = performance.now() - startTime;

    const finalDetail = typeof detail === 'function' ? detail(result) : detail;
    this.addStepWithDuration(step, duration, finalDetail);

    return result;
  }

  /**
   * 测量并记录同步步骤耗时
   * @param step 步骤名称
   * @param fn 要执行的同步函数
   * @param detail 步骤详情
   * @returns 函数执行结果
   */
  measureStepSync<T>(
    step: string,
    fn: () => T,
    detail?: any | ((result: T) => any)
  ): T {
    const startTime = performance.now();
    const result = fn();
    const duration = performance.now() - startTime;

    const finalDetail = typeof detail === 'function' ? detail(result) : detail;
    this.addStepWithDuration(step, duration, finalDetail);

    return result;
  }

  /**
   * 设置请求体（用于记录）
   * @param body 请求体内容
   */
  setRequestBody(body: any) {
    this.requestBody = body;
  }

  /**
   * 设置响应体（用于记录）
   * @param body 响应体内容
   */
  setResponseBody(body: any) {
    this.responseBody = body;
  }

  /**
   * 设置请求头（用于记录）
   * @param headers 请求头
   */
  setRequestHeaders(headers: Record<string, string>) {
    this.requestHeaders = headers;
    this.requestAccept = Object.entries(headers).find(([name]) => name.toLowerCase() === 'accept')?.[1] ?? '';
  }

  /**
   * 设置响应头（用于记录）
   * @param headers 响应头
   */
  setResponseHeaders(headers: Record<string, string>) {
    this.responseHeaders = headers;
  }

  /**
   * 设置原始请求头（转换前）
   * @param headers 原始请求头
   */
  setOriginalRequestHeaders(headers: Record<string, string>) {
    this.originalRequestHeaders = headers;
  }

  /**
   * 设置原始请求体（转换前）
   * @param body 原始请求体
   */
  setOriginalRequestBody(body: any) {
    this.originalRequestBody = body;
  }

  /**
   * 设置转换后的路径（经过 pathRewrite）
   * @param path 转换后的路径
   */
  setTransformedPath(path: string) {
    this.transformedPath = path;
  }

  /**
   * 设置请求类型分类
   * @param type 请求类型: 'final' | 'retry' | 'recovery'
   */
  setRequestType(type: 'final' | 'retry' | 'recovery') {
    this.requestType = type;
  }

  /**
   * 完成请求并写入日志。同一进行中的调用共享 Promise；SQLite 入队成功后重复调用不会重复入队。
   * 入队前失败可重试，入队后的文件日志失败仅重试文件日志。
   * @param status HTTP 状态码
   * @param options 其他选项
   */
  complete(
    status: number,
    options?: RequestLogCompletionOptions,
  ): Promise<void> {
    if (this.completionPromise) return this.completionPromise;
    if (this.completed) {
      return this.fileLogWritten ? Promise.resolve() : this.trackCompletion(this.writeFileLog());
    }

    return this.trackCompletion(this.completeOnce(status, options));
  }

  private trackCompletion(completion: Promise<void>): Promise<void> {
    this.completionPromise = completion;
    completion.then(
      () => { this.completionPromise = null; },
      () => { this.completionPromise = null; },
    );
    return completion;
  }

  private async completeOnce(
    status: number,
    options?: RequestLogCompletionOptions,
  ): Promise<void> {
    const duration = Date.now() - this.startTime;

    // 保存 body（如果启用）
    let reqBodyId: string | null = null;
    let respBodyId: string | null = null;

    if (!this.capturedTypes.has('request') && this.requestBody !== null && this.requestBody !== undefined && this.dependencies.bodyStorage) {
      reqBodyId = await this.saveBody(this.requestBody, 'request');
    }

    if (!this.capturedTypes.has('response') && this.responseBody !== null && this.responseBody !== undefined && this.dependencies.bodyStorage) {
      // 错误响应（>=400）不受大小限制
      const isErrorResponse = status >= 400;
      respBodyId = await this.saveBody(this.responseBody, 'response', isErrorResponse);
    }

    // 保存 headers（默认启用）
    let reqHeaderId: string | null = null;
    let respHeaderId: string | null = null;
    let originalReqHeaderId: string | null = null;

    if (this.requestHeaders && this.dependencies.headerStorage) {
      reqHeaderId = await this.dependencies.headerStorage.save(
        this.requestId,
        this.requestHeaders,
        'request'
      );
    }

    if (this.responseHeaders && this.dependencies.headerStorage) {
      respHeaderId = await this.dependencies.headerStorage.save(
        this.requestId,
        this.responseHeaders,
        'response'
      );
    }

    if (this.originalRequestHeaders && this.dependencies.headerStorage) {
      originalReqHeaderId = await this.dependencies.headerStorage.save(
        this.requestId,
        this.originalRequestHeaders,
        'original-request'
      );
    }

    // 保存原始请求体（如果有）
    let originalReqBodyId: string | null = null;

    if (!this.capturedTypes.has('original-request') && this.originalRequestBody !== null && this.originalRequestBody !== undefined && this.dependencies.bodyStorage) {
      originalReqBodyId = await this.saveBody(this.originalRequestBody, 'original-request');
    }

    // 构建日志条目
    const protocolError = options?.protocolError ?? this.protocolError;
    const errorMessage = diagnosticMessage(protocolError) ?? options?.errorMessage;
    if (protocolError) this.addStep('response_error', protocolError);
    const logEntry = {
      requestId: this.requestId,
      timestamp: this.startTime,
      method: this.method,
      path: this.path,
      query: this.query || undefined,
      status,
      duration,
      processingSteps: this.steps.length > 0 ? this.steps : undefined,
      reqBodyId: this.capturedIds.get('request') ?? reqBodyId ?? undefined,
      respBodyId: this.capturedIds.get('response') ?? respBodyId ?? undefined,
      reqHeaderId: reqHeaderId || undefined,
      respHeaderId: respHeaderId || undefined,
      originalReqHeaderId: originalReqHeaderId || undefined,
      originalReqBodyId: this.capturedIds.get('original-request') ?? originalReqBodyId ?? undefined,
      transformedPath: this.transformedPath || undefined,
      // 故障转移相关字段
      isFailoverAttempt: this.isFailoverAttempt || undefined,
      parentRequestId: this.parentRequestId || undefined,
      attemptNumber: this.attemptNumber || undefined,
      attemptUpstream: this.attemptUpstream || undefined,
      requestType: this.requestType,
      protocolOutcome: options?.protocolOutcome,
      protocolCode: options?.protocolCode,
      success: options?.success,
      ...options,
      transportOutcome: this.transportOutcome,
      transportCode: this.transportCode,
      replacePendingTransport: this.transportStarted,
      errorMessage,
    };

    this.fileLogEntry = {
      requestId: this.requestId,
      timestamp: this.startTime,
      method: this.method,
      path: this.path,
      query: this.query || undefined,
      status,
      duration,
      routePath: options?.routePath,
      upstream: options?.upstream,
      transformer: options?.transformer,
      transformedPath: this.transformedPath || undefined,
      authSuccess: options?.authSuccess,
      authLevel: options?.authLevel,
      errorMessage,
      reqBodyId: this.capturedIds.get('request') ?? reqBodyId ?? undefined,
      respBodyId: this.capturedIds.get('response') ?? respBodyId ?? undefined,
      reqHeaderId: reqHeaderId || undefined,
      respHeaderId: respHeaderId || undefined,
      originalReqHeaderId: originalReqHeaderId || undefined,
      originalReqBodyId: this.capturedIds.get('original-request') ?? originalReqBodyId ?? undefined,
      // 故障转移相关字段
      isFailoverAttempt: this.isFailoverAttempt || undefined,
      parentRequestId: this.parentRequestId || undefined,
      attemptNumber: this.attemptNumber || undefined,
      attemptUpstream: this.attemptUpstream || undefined,
      requestType: this.requestType,
      protocolOutcome: options?.protocolOutcome,
      protocolCode: options?.protocolCode,
      success: options?.success,
      transportOutcome: this.transportOutcome,
      transportCode: this.transportCode,
    };

    // write() 返回即表示已入队；此后 complete 幂等，避免附属文件日志失败时重复入队。
    this.dependencies.accessLogWriter.write(logEntry);
    this.completed = true;
    await this.writeFileLog();
  }

  private async saveBody(body: unknown, type: 'request' | 'response' | 'original-request', isError = false): Promise<string | null> {
    const storage = this.dependencies.bodyStorage;
    if (!storage) return null;
    const bodyId = await storage.save(this.requestId, body, type, isError);
    const config = storage.getConfig?.();
    if (!bodyId && config?.enabled && !isError) {
      try {
        const serialized = typeof body === 'string' ? body : JSON.stringify(body);
        if (serialized !== undefined) {
          const bytes = Buffer.byteLength(serialized);
          if (bytes > config.maxSize) this.addStep('body_recording_skipped', {
            type, reason: 'size_limit', bytes, maxBytes: config.maxSize,
          });
        }
      } catch {
        // Storage already handles serialization failures; diagnostics must not
        // make a successful proxy request fail during log completion.
      }
    }
    return bodyId;
  }

  private async writeFileLog(): Promise<void> {
    if (this.fileLogTask || this.fileLogWritten || !this.fileLogEntry) return;
    // complete() may run before the returned response reaches EOF. Do not wait here:
    // that would prevent the very EOF needed to release this diagnostic record.
    if (this.deferTransportFileLog && (!this.clientTransportObserved || this.transportOutcome === 'pending')) return;
    if (this.fileLogReady || this.bodyCaptures.size || this.inheritedBodyCompletions.size) {
      // JSONL is immutable after flush: enqueue only when its body references are final.
      // The task is part of the logging shutdown flush, never the HTTP completion wait.
      this.fileLogTask = (this.fileLogReady ?? Promise.resolve()).then(() => this.bodyLoggingCompletion()).then(async () => {
        await this.dependencies.fileLogWriter.write(this.fileLogEntry!);
        this.fileLogWritten = true;
      }).catch(error => {
        this.fileLogTask = undefined;
        console.error('Failed to enqueue completed body log:', { requestId: this.requestId, error });
      });
      trackBodyLogTask(this.fileLogTask);
      return;
    }
    if (this.fileLogWritePromise) return this.fileLogWritePromise;
    const write = this.dependencies.fileLogWriter.write(this.fileLogEntry).then(() => { this.fileLogWritten = true; });
    this.fileLogWritePromise = write;
    try { await write; } finally { if (this.fileLogWritePromise === write) this.fileLogWritePromise = null; }
  }

  /** The request handler enables this before any completion can serialize a final JSONL record. */
  deferFileLogUntilTransportObserved(): void {
    this.deferTransportFileLog = true;
  }

  /** The attempt was superseded or the handler threw before returning a response. */
  releaseUnreturnedTransportFileLog(): void {
    this.deferTransportFileLog = false;
    this.enqueueReadyFileLog();
  }

  private enqueueReadyFileLog(): void {
    if (this.fileLogEntry && !this.fileLogWritten) {
      void this.writeFileLog().catch(error => console.error('Failed to enqueue transport file log:', error));
    }
  }

  /** 显式持久化没有 upstream attempt 的 root final 记录。 */
  async persistRoot(
    status: number,
    options?: RequestLogCompletionOptions,
  ): Promise<void> {
    if (this.rootPersisted) return;
    await this.complete(status, options);
    this.rootPersisted = true;
  }

  async persistStreamResponseBody(body: unknown): Promise<string | null> {
    return this.dependencies.bodyStorage?.save(this.requestId, body, 'response', true) ?? null;
  }

  updateStreamResponseBodyId(bodyId: string): void {
    this.dependencies.accessLogWriter.updateResponseBodyId(this.requestId, bodyId);
  }

  /** Publish in-progress metadata without saving bodies or finalizing plugin/accounting hooks. */
  beginTransport(status: number, options: Pick<RequestLogCompletionOptions, 'routePath' | 'upstream'> = {}): void {
    this.clientTransportObserved = true;
    this.updateTransportOutcome('pending');
    if (this.completed || this.transportStarted) return;
    this.transportStarted = true;
    this.dependencies.accessLogWriter.write({
      requestId: this.requestId, timestamp: this.startTime, method: this.method, path: this.path,
      query: this.query || undefined, status, duration: Date.now() - this.startTime,
      processingSteps: this.steps.length ? this.steps : undefined,
      requestType: this.requestType, isFailoverAttempt: this.isFailoverAttempt,
      parentRequestId: this.parentRequestId ?? undefined, attemptNumber: this.attemptNumber ?? undefined,
      attemptUpstream: this.attemptUpstream ?? undefined, ...options,
      transportOutcome: 'pending',
    });
  }

  updateTransportOutcome(outcome: TransportOutcome, code?: string): void {
    this.transportOutcome = outcome;
    this.transportCode = code;
    if (this.fileLogEntry) { this.fileLogEntry.transportOutcome = outcome; this.fileLogEntry.transportCode = code; }
    this.dependencies.accessLogWriter.updateTransportOutcome?.(this.requestId, outcome, code);
    if (this.clientTransportObserved && outcome !== 'pending') this.enqueueReadyFileLog();
  }

  /** Earlier attempts observe their upstream; the returned response owns the final observation. */
  updateUpstreamTransportOutcome(outcome: TransportOutcome, code?: string): void {
    if (!this.clientTransportObserved) this.updateTransportOutcome(outcome, code);
  }

  updateProtocolOutcome(
    outcome: 'completed' | 'failed' | 'incomplete' | 'cancelled',
    success: boolean,
    code?: string,
    error?: RawResponseError,
  ): void {
    this.protocolError = error;
    this.dependencies.accessLogWriter.updateProtocolOutcome(this.requestId, outcome, success, code, diagnosticMessage(error));
  }

  /**
   * 获取 Request ID（用于日志关联）
   */
  getRequestId(): string {
    return this.requestId;
  }

  /**
   * 获取请求基本信息（用于传统日志输出）
   */
  getRequestInfo() {
    return {
      requestId: this.requestId,
      method: this.method,
      url: this.path,
      search: this.query,
    };
  }

  /**
   * 获取所有处理步骤（用于步骤传递）
   * @returns 处理步骤数组的副本
   */
  getSteps(): ProcessingStep[] {
    return [...this.steps];
  }

  /**
   * 批量添加处理步骤（用于步骤合并）
   * @param steps 要添加的步骤数组
   */
  addSteps(steps: ProcessingStep[]) {
    this.steps.push(...steps);
  }
}
