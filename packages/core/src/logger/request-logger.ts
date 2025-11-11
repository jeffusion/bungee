import { accessLogWriter, type ProcessingStep } from './access-log-writer';
import { fileLogWriter } from './file-log-writer';
import { bodyStorageManager } from './body-storage';
import { headerStorageManager } from './header-storage';

export interface FailoverAttemptOptions {
  isFailoverAttempt?: boolean;   // 是否是故障转移尝试
  parentRequestId?: string;      // 父请求 ID
  attemptNumber?: number;        // 尝试序号
  attemptUpstream?: string;      // 尝试的上游地址
  requestType?: 'final' | 'retry' | 'recovery';  // 请求类型分类
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

  constructor(req: Request, failoverOptions?: FailoverAttemptOptions) {
    this.requestId = crypto.randomUUID();
    this.startTime = Date.now();
    const url = new URL(req.url);
    this.method = req.method;
    this.path = url.pathname;
    this.query = url.search;

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
   * 添加处理步骤
   * @param step 步骤名称，如：'auth', 'path_rewrite', 'transformer', 'body_add'
   * @param detail 步骤详情
   */
  addStep(step: string, detail?: any) {
    this.steps.push({
      step,
      detail,
      timestamp: Date.now(),
    });
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
   * 完成请求并写入日志
   * @param status HTTP 状态码
   * @param options 其他选项
   */
  async complete(
    status: number,
    options?: {
      routePath?: string;
      upstream?: string;
      transformer?: string;
      authSuccess?: boolean;
      authLevel?: string;
      errorMessage?: string;
    }
  ): Promise<void> {
    const duration = Date.now() - this.startTime;

    // 保存 body（如果启用）
    let reqBodyId: string | null = null;
    let respBodyId: string | null = null;

    if (this.requestBody) {
      reqBodyId = await bodyStorageManager.save(
        this.requestId,
        this.requestBody,
        'request'
      );
    }

    if (this.responseBody) {
      // 错误响应（>=400）不受大小限制
      const isErrorResponse = status >= 400;
      respBodyId = await bodyStorageManager.save(
        this.requestId,
        this.responseBody,
        'response',
        isErrorResponse
      );
    }

    // 保存 headers（默认启用）
    let reqHeaderId: string | null = null;
    let respHeaderId: string | null = null;
    let originalReqHeaderId: string | null = null;

    if (this.requestHeaders) {
      reqHeaderId = await headerStorageManager.save(
        this.requestId,
        this.requestHeaders,
        'request'
      );
    }

    if (this.responseHeaders) {
      respHeaderId = await headerStorageManager.save(
        this.requestId,
        this.responseHeaders,
        'response'
      );
    }

    if (this.originalRequestHeaders) {
      originalReqHeaderId = await headerStorageManager.save(
        this.requestId,
        this.originalRequestHeaders,
        'original-request'
      );
    }

    // 保存原始请求体（如果有）
    let originalReqBodyId: string | null = null;

    if (this.originalRequestBody) {
      originalReqBodyId = await bodyStorageManager.save(
        this.requestId,
        this.originalRequestBody,
        'original-request'
      );
    }

    // 构建日志条目
    const logEntry = {
      requestId: this.requestId,
      timestamp: this.startTime,
      method: this.method,
      path: this.path,
      query: this.query || undefined,
      status,
      duration,
      processingSteps: this.steps.length > 0 ? this.steps : undefined,
      reqBodyId: reqBodyId || undefined,
      respBodyId: respBodyId || undefined,
      reqHeaderId: reqHeaderId || undefined,
      respHeaderId: respHeaderId || undefined,
      originalReqHeaderId: originalReqHeaderId || undefined,
      originalReqBodyId: originalReqBodyId || undefined,
      transformedPath: this.transformedPath || undefined,
      // 故障转移相关字段
      isFailoverAttempt: this.isFailoverAttempt || undefined,
      parentRequestId: this.parentRequestId || undefined,
      attemptNumber: this.attemptNumber || undefined,
      attemptUpstream: this.attemptUpstream || undefined,
      requestType: this.requestType,
      ...options,
    };

    // 写入文件日志
    await fileLogWriter.write({
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
      errorMessage: options?.errorMessage,
      reqBodyId: reqBodyId || undefined,
      respBodyId: respBodyId || undefined,
      reqHeaderId: reqHeaderId || undefined,
      respHeaderId: respHeaderId || undefined,
      originalReqHeaderId: originalReqHeaderId || undefined,
      originalReqBodyId: originalReqBodyId || undefined,
      // 故障转移相关字段
      isFailoverAttempt: this.isFailoverAttempt || undefined,
      parentRequestId: this.parentRequestId || undefined,
      attemptNumber: this.attemptNumber || undefined,
      attemptUpstream: this.attemptUpstream || undefined,
      requestType: this.requestType,
    });

    // 写入 SQLite（异步，不等待完成）
    accessLogWriter.write(logEntry);
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
