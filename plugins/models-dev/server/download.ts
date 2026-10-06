/**
 * models-dev upstream download. This is the ONLY place that touches
 * `https://models.dev/api.json`; every other consumer reads the loaded catalog.
 * The full body is bounded and parsed as-is (no field trimming).
 */

import { MODELS_DEV_SOURCE_URL } from '../contract';

export const MAX_CATALOG_BODY_BYTES = 16 * 1024 * 1024;
export const DEFAULT_DOWNLOAD_TIMEOUT_SECONDS = 15;

export interface DownloadCatalogInput {
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
  readonly url?: string;
  readonly maxBytes?: number;
}

async function readBoundedBody(response: Response, maxBytes: number, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new Error('catalog download cancelled');
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel();
    throw new Error('catalog body limit exceeded');
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal?.aborted) throw new Error('catalog download cancelled');
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('catalog body limit exceeded');
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(body);
}

/** Download and parse the full catalog. Throws on transport/shape failure. */
export async function downloadModelsDevCatalog(input: DownloadCatalogInput = {}): Promise<unknown> {
  const url = input.url ?? MODELS_DEV_SOURCE_URL;
  const maxBytes = input.maxBytes ?? MAX_CATALOG_BODY_BYTES;
  const response = await (input.fetch ?? globalThis.fetch)(url, {
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`catalog download failed with status ${response.status}`);
  const body = await readBoundedBody(response, maxBytes, input.signal);
  if (input.signal?.aborted) throw new Error('catalog download cancelled');
  const parsed: unknown = JSON.parse(body);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('catalog payload is invalid');
  return parsed;
}
