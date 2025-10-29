import { api } from './client';

export interface ProcessingStep {
  step: string;
  detail?: any;
  timestamp: number;
}

export interface LogEntry {
  id: number;
  requestId: string;
  timestamp: number;
  method: string;
  path: string;
  query?: string;
  status: number;
  duration: number;
  routePath?: string;
  upstream?: string;
  transformer?: string;
  transformedPath?: string;       // 转换后的路径（经过 pathRewrite）
  processingSteps?: ProcessingStep[];
  authSuccess: boolean;
  authLevel?: string;
  errorMessage?: string;
  success: boolean;
  reqBodyId?: string;
  respBodyId?: string;
  reqHeaderId?: string;
  respHeaderId?: string;
  originalReqHeaderId?: string;  // 原始请求头 ID（转换前）
  originalReqBodyId?: string;     // 原始请求体 ID（转换前）
  requestType?: 'final' | 'retry' | 'recovery';  // 请求类型分类
}

export interface LogQueryParams {
  page?: number;
  limit?: number;
  startTime?: number;
  endTime?: number;
  method?: string;
  path?: string;
  status?: number | number[];
  routePath?: string;
  upstream?: string;
  transformer?: string;
  success?: boolean;
  searchTerm?: string;
  sortBy?: 'timestamp' | 'duration' | 'status';
  sortOrder?: 'asc' | 'desc';
  requestType?: 'final' | 'retry' | 'recovery';  // 请求类型筛选
}

export interface LogQueryResult {
  data: LogEntry[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * 查询日志列表
 */
export async function queryLogs(params: LogQueryParams = {}): Promise<LogQueryResult> {
  const queryParams = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      if (Array.isArray(value)) {
        value.forEach(v => queryParams.append(key, String(v)));
      } else {
        queryParams.append(key, String(value));
      }
    }
  });

  return api.get<LogQueryResult>(`/logs?${queryParams.toString()}`);
}

/**
 * 根据 Request ID 获取单条日志
 */
export async function getLogById(requestId: string): Promise<LogEntry> {
  return api.get<LogEntry>(`/logs/${requestId}`);
}

/**
 * 导出日志
 */
export async function exportLogs(params: LogQueryParams = {}, format: 'json' | 'csv' = 'json'): Promise<Blob> {
  const queryParams = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      queryParams.append(key, String(value));
    }
  });

  queryParams.append('format', format);

  const response = await fetch(`/__ui/api/logs/export?${queryParams.toString()}`);

  if (!response.ok) {
    throw new Error('Failed to export logs');
  }

  return response.blob();
}

/**
 * 创建实时日志流（SSE）
 */
export function createLogStream(interval: number = 1000): EventSource {
  return new EventSource(`/__ui/api/logs/stream?interval=${interval}`);
}

/**
 * 根据 Body ID 加载 body 内容
 */
export async function loadBodyById(bodyId: string): Promise<any> {
  const response = await api.get<{ bodyId: string; content: any }>(`/logs/body/${bodyId}`);
  return response.content;
}

/**
 * 根据 Header ID 加载 headers 内容
 */
export async function loadHeaderById(headerId: string): Promise<Record<string, string>> {
  return api.get<Record<string, string>>(`/logs/headers/${headerId}`);
}

/**
 * 清理配置接口
 */
export interface CleanupConfig {
  enabled: boolean;
  retentionDays: number;
  scheduleIntervalHours: number;
  isActive: boolean;
}

/**
 * 清理结果接口
 */
export interface CleanupResult {
  deletedSqliteRecords: number;
  deletedFileLogFiles: number;
  deletedBodyDirs: number;
  deletedBodyFiles: number;
  durationMs: number;
}

/**
 * 获取日志清理配置
 */
export async function getCleanupConfig(): Promise<CleanupConfig> {
  return api.get<CleanupConfig>('/logs/cleanup/config');
}

/**
 * 更新日志清理配置
 */
export async function updateCleanupConfig(config: Partial<CleanupConfig>): Promise<CleanupConfig> {
  return api.put<CleanupConfig>('/logs/cleanup/config', config);
}

/**
 * 手动触发日志清理
 */
export async function triggerCleanup(): Promise<CleanupResult> {
  return api.post<CleanupResult>('/logs/cleanup');
}
