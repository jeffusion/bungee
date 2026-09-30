/**
 * Request snapshot module for failover isolation
 * Captures request state before plugin execution to enable clean retries
 */

import { logger } from '../../logger';
import type { RequestSnapshot } from '../types';
import { parseBodyParserLimit } from '../../config-storage/global-scalars';

/**
 * A rejected request must be reported as 413 before any upstream is attempted.
 */
export class RequestBodyTooLargeError extends Error {
  readonly code = 'request_body_too_large';

  constructor(readonly maxBytes: number, readonly receivedBytes: number) {
    super(`Request body too large (max: ${maxBytes} bytes, received: ${receivedBytes} bytes)`);
    this.name = 'RequestBodyTooLargeError';
  }
}

async function readRequestBody(req: Request, maxBytes: number): Promise<Uint8Array> {
  const reader = req.clone().body!.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) throw new RequestBodyTooLargeError(maxBytes, totalBytes);
      chunks.push(value);
    }
  } catch (error) {
    // Cancel both clone branches to stop reading an oversized upload. A single
    // branch's cancellation may wait for the other, so do not await either here.
    void reader.cancel(error).catch(() => undefined);
    void req.body?.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Creates a snapshot of the request for failover isolation
 *
 * This function captures the complete request state before any plugin modifications.
 * Each upstream retry will receive a clean copy reconstructed from this snapshot,
 * ensuring that plugin modifications don't affect subsequent retries.
 *
 * **Key features:**
 * - JSON body: Parsed but NOT immediately cloned (lazy clone optimization)
 * - Binary body: Stored as ArrayBuffer (can be reused multiple times)
 * - Headers: Captured as plain object
 * - Size limit: Uses the global body_parser_limit (50MB by default)
 *
 * @param req - Incoming HTTP request
 * @param bodyParserLimit - Global maximum request size, including its unit
 * @returns Promise resolving to request snapshot
 * @throws {Error} If request body exceeds size limit
 * @throws {Error} If JSON body parsing fails
 *
 * @example
 * ```typescript
 * const snapshot = await createRequestSnapshot(req);
 *
 * // First attempt - uses original parsed body (no clone)
 * const response = await proxyRequest(snapshot, ...);
 *
 * // Failover retry - ensure snapshot is cloned before retry
 * if (needsRetry) {
 *   ensureSnapshotCloned(snapshot);
 *   const retryResponse = await proxyRequest(snapshot, ...);
 * }
 * ```
 */
export async function createRequestSnapshot(req: Request, bodyParserLimit?: string): Promise<RequestSnapshot> {
  const maxBytes = parseBodyParserLimit(bodyParserLimit);
  // Check content length to prevent memory overflow
  const contentLength = req.headers.get('content-length');
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new RequestBodyTooLargeError(maxBytes, Number(contentLength));
  }

  // Capture headers
  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headers[key] = value;
  });

  const content_type = req.headers.get('content-type') || '';
  const is_json_body = content_type.includes('application/json');

  let body: any = null;

  if (req.body) {
    const bytes = await readRequestBody(req, maxBytes);
    if (is_json_body) {
      // JSON body - parse but DO NOT clone immediately (lazy clone optimization)
      // Clone will be done on-demand when failover retry is needed
      try {
        body = JSON.parse(new TextDecoder().decode(bytes));
        // 不再立即 structuredClone，延迟到 ensureSnapshotCloned() 调用时
      } catch (err) {
        logger.error({ error: err }, 'Failed to parse JSON body for snapshot');
        throw new Error('Invalid JSON body: ' + (err as Error).message);
      }
    } else {
      // Non-JSON body - read as ArrayBuffer (can be reused multiple times)
      // ArrayBuffer is a byte array, not a stream, so it's safe to reuse
      body = bytes.buffer;
    }
  }

  return {
    method: req.method,
    url: req.url,
    headers,  // Already a new object from forEach, no need to clone
    body,
    content_type,
    is_json_body,
    is_body_cloned: false  // 标记为未克隆
  };
}

/**
 * Ensures the snapshot is fully cloned for failover retries
 *
 * This function implements the lazy clone strategy for both body and headers:
 * - First call: Executes structuredClone and marks as cloned
 * - Subsequent calls: No-op, returns immediately
 *
 * **When to call:**
 * - Before the second and subsequent upstream retry attempts
 * - NOT needed for the first attempt (uses original parsed data)
 *
 * **Why lazy clone:**
 * - ~95% of requests succeed on first attempt (no failover needed)
 * - structuredClone is expensive (1-10ms for typical JSON bodies)
 * - Lazy clone avoids this overhead for the majority of requests
 *
 * @param snapshot - Request snapshot to ensure is fully cloned
 * @returns The same snapshot (mutated in-place)
 *
 * @example
 * ```typescript
 * // In failover loop
 * if (attemptNumber > 1) {
 *   ensureSnapshotCloned(snapshot);
 * }
 * ```
 */
export function ensureSnapshotCloned(snapshot: RequestSnapshot): RequestSnapshot {
  // Clone headers if not already cloned
  if (!snapshot.is_headers_cloned) {
    snapshot.headers = structuredClone(snapshot.headers);
    snapshot.is_headers_cloned = true;

    logger.debug(
      { headerCount: Object.keys(snapshot.headers).length },
      'Snapshot headers cloned for failover retry (lazy clone)'
    );
  }

  // Clone JSON body if not already cloned
  if (!snapshot.is_body_cloned && snapshot.is_json_body && snapshot.body !== null) {
    snapshot.body = structuredClone(snapshot.body);
    snapshot.is_body_cloned = true;

    logger.debug(
      { bodySize: JSON.stringify(snapshot.body).length },
      'Snapshot body cloned for failover retry (lazy clone)'
    );
  }

  return snapshot;
}

/**
 * @deprecated Use ensureSnapshotCloned instead (clones both headers and body)
 */
export function ensureSnapshotBodyCloned(snapshot: RequestSnapshot): RequestSnapshot {
  return ensureSnapshotCloned(snapshot);
}
