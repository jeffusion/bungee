/**
 * Request snapshot module for failover isolation
 * Captures request state before plugin execution to enable clean retries
 */

import { logger } from '../../logger';
import type { RequestSnapshot } from '../types';

/**
 * Maximum allowed request body size for snapshot creation
 * Prevents memory exhaustion from large uploads
 */
const MAX_SNAPSHOT_BODY_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * Creates a snapshot of the request for failover isolation
 *
 * This function captures the complete request state before any plugin modifications.
 * Each upstream retry will receive a clean copy reconstructed from this snapshot,
 * ensuring that plugin modifications don't affect subsequent retries.
 *
 * **Key features:**
 * - JSON body: Parsed and deep cloned using structuredClone
 * - Binary body: Stored as ArrayBuffer (can be reused multiple times)
 * - Headers: Captured as plain object
 * - Size limit: Rejects bodies larger than 10MB to prevent OOM
 *
 * @param req - Incoming HTTP request
 * @returns Promise resolving to request snapshot
 * @throws {Error} If request body exceeds size limit
 * @throws {Error} If JSON body parsing fails
 *
 * @example
 * ```typescript
 * const snapshot = await createRequestSnapshot(req);
 * // Later, reconstruct clean request for retry
 * const cleanBody = snapshot.isJsonBody
 *   ? JSON.stringify(snapshot.body)
 *   : snapshot.body;
 * ```
 */
export async function createRequestSnapshot(req: Request): Promise<RequestSnapshot> {
  // Check content length to prevent memory overflow
  const contentLength = req.headers.get('content-length');
  if (contentLength && parseInt(contentLength) > MAX_SNAPSHOT_BODY_SIZE) {
    const sizeMB = parseInt(contentLength) / 1024 / 1024;
    const maxMB = MAX_SNAPSHOT_BODY_SIZE / 1024 / 1024;
    throw new Error(
      `Request body too large for failover (max: ${maxMB}MB, got: ${sizeMB.toFixed(2)}MB)`
    );
  }

  // Capture headers
  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headers[key] = value;
  });

  const contentType = req.headers.get('content-type') || '';
  const isJsonBody = contentType.includes('application/json');

  let body: any = null;

  if (req.body) {
    if (isJsonBody) {
      // JSON body - parse and deep clone for complete isolation
      try {
        body = await req.clone().json();
        // Use structuredClone for deep copy (Web standard, faster than lodash)
        body = structuredClone(body);
      } catch (err) {
        logger.error({ error: err }, 'Failed to parse JSON body for snapshot');
        throw new Error('Invalid JSON body: ' + (err as Error).message);
      }
    } else {
      // Non-JSON body - read as ArrayBuffer (can be reused multiple times)
      // ArrayBuffer is a byte array, not a stream, so it's safe to reuse
      body = await req.clone().arrayBuffer();
    }
  }

  return {
    method: req.method,
    url: req.url,
    headers,  // Already a new object from forEach, no need to clone
    body,
    contentType,
    isJsonBody
  };
}
