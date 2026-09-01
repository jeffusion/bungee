import {
  INTERNAL_TRANSPORT_ORIGINAL_URL_HEADER,
  INTERNAL_TRANSPORT_TOKEN_HEADER,
  parseWorkerTransportSecret,
} from '../../src/config-worker/private-transport';

export const TEST_WORKER_TRANSPORT_SECRET = parseWorkerTransportSecret('A'.repeat(43));

export function privateWorkerHeaders(originalUrl: string, initial?: HeadersInit): Headers {
  const headers = new Headers(initial);
  headers.set(INTERNAL_TRANSPORT_TOKEN_HEADER, TEST_WORKER_TRANSPORT_SECRET);
  headers.set(INTERNAL_TRANSPORT_ORIGINAL_URL_HEADER, originalUrl);
  return headers;
}
