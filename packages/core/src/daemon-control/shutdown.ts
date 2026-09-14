import { timingSafeEqual } from 'node:crypto';
import {
  DAEMON_CONTROL_HTTP_PREFIX,
  DAEMON_AUTHORIZATION_HEADER,
  DAEMON_BOOT_HEADER,
  DAEMON_INSTANCE_HEADER,
  DAEMON_PID_HEADER,
  DAEMON_SHUTDOWN_PATH,
  type DaemonMetadataV1,
} from '@jeffusion/bungee-types';

export {
  DAEMON_AUTHORIZATION_HEADER,
  DAEMON_BOOT_HEADER,
  DAEMON_CONTROL_HTTP_PREFIX,
  DAEMON_INSTANCE_HEADER,
  DAEMON_PID_HEADER,
  DAEMON_SHUTDOWN_PATH,
} from '@jeffusion/bungee-types';

export type ConstantTimeComparator = (left: Uint8Array, right: Uint8Array) => boolean;

export type DaemonControlRequestContext = {
  readonly onResponseSettled: (callback: () => void, onError?: (error: unknown) => void) => void;
};

export type DaemonShutdownHandler = {
  readonly handle: (request: Request, context?: DaemonControlRequestContext) => Promise<Response>;
  readonly accepted: boolean;
};

export type DaemonShutdownHandlerOptions = {
  readonly metadata: DaemonMetadataV1 | (() => DaemonMetadataV1);
  readonly isReady?: () => boolean;
  readonly onShutdownRequested: () => void | Promise<void>;
  readonly onShutdownError?: (error: unknown) => void;
  readonly comparator?: ConstantTimeComparator;
};

const JSON_HEADERS = {
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
} as const;
const NOT_FOUND_BODY = JSON.stringify({ error: 'not_found' });
const STARTING_BODY = JSON.stringify({ error: 'starting' });
function acceptedBody(metadata: DaemonMetadataV1): string {
  return JSON.stringify({ status: 'accepted', boot_nonce: metadata.boot_nonce, instance_id: metadata.instance_id, pid: metadata.pid });
}

function notFound(): Response {
  return new Response(NOT_FOUND_BODY, { status: 404, headers: JSON_HEADERS });
}

function response(body: string, status: number): Response {
  return new Response(body, { status, headers: JSON_HEADERS });
}

function singleHeader(request: Request, name: string): string | null {
  const value = request.headers.get(name);
  if (value === null || value.includes(',')) return null;
  return value;
}

const SECRET_BYTES = 43;

function bearerCandidate(value: string | null): { readonly bytes: Uint8Array; readonly length: number; readonly canonical: boolean } {
  const bytes = new Uint8Array(SECRET_BYTES);
  if (value === null || !value.startsWith('Bearer ')) return { bytes, length: 0, canonical: false };
  const length = value.length - 'Bearer '.length;
  const copied = Math.min(length, SECRET_BYTES);
  let canonical = length === SECRET_BYTES;
  for (let index = 0; index < copied; index += 1) {
    const code = value.charCodeAt('Bearer '.length + index);
    if (!((code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a)
      || (code >= 0x61 && code <= 0x7a) || code === 0x2d || code === 0x5f)) canonical = false;
    bytes[index] = code;
  }
  return { bytes, length, canonical };
}

function defaultComparator(left: Uint8Array, right: Uint8Array): boolean {
  return timingSafeEqual(left, right);
}

function validBaseRequest(
  request: Request,
  metadata: DaemonMetadataV1,
  expectedSecret: Uint8Array,
  comparator: ConstantTimeComparator,
): boolean {
  const url = new URL(request.url);
  const authorization = singleHeader(request, DAEMON_AUTHORIZATION_HEADER);
  const candidate = bearerCandidate(authorization);
  const secretEqual = comparator(candidate.bytes, expectedSecret);
  const boot = singleHeader(request, DAEMON_BOOT_HEADER);
  const contentLength = singleHeader(request, 'content-length');
  const transferEncoding = request.headers.get('transfer-encoding');
  return request.method === 'POST'
    && url.pathname === DAEMON_SHUTDOWN_PATH
    && url.search === ''
    && candidate.canonical
    && secretEqual
    && boot === metadata.boot_nonce
    && contentLength === '0'
    && transferEncoding === null
    && request.body === null;
}

function validRequest(
  request: Request,
  metadata: DaemonMetadataV1,
  expectedSecret: Uint8Array,
  comparator: ConstantTimeComparator,
): boolean {
  if (!validBaseRequest(request, metadata, expectedSecret, comparator)) return false;
  if (metadata.state === 'launching') return true;
  const pid = request.headers.get(DAEMON_PID_HEADER);
  if (metadata.state === 'starting') return pid === null || (!pid.includes(',') && pid === String(metadata.pid));
  return singleHeader(request, DAEMON_INSTANCE_HEADER) === metadata.instance_id
    && singleHeader(request, DAEMON_PID_HEADER) === String(metadata.pid);
}

export function createDaemonShutdownHandler(options: DaemonShutdownHandlerOptions): DaemonShutdownHandler {
  const comparator = options.comparator ?? defaultComparator;
  let accepted = false;
  let acceptedResponseBody: string | null = null;
  const readMetadata = (): DaemonMetadataV1 => typeof options.metadata === 'function' ? options.metadata() : options.metadata;
  const initialMetadata = readMetadata();
  const expectedSecret = new Uint8Array(SECRET_BYTES);
  const encodedSecret = new TextEncoder().encode(initialMetadata.shutdown_secret);
  expectedSecret.set(encodedSecret.subarray(0, SECRET_BYTES));

  return {
    get accepted() { return accepted; },
    async handle(request, context) {
      const metadata = readMetadata();
      if (!validRequest(request, metadata, expectedSecret, comparator)) return notFound();
      if (metadata.state === 'launching' || metadata.state === 'starting' || options.isReady?.() === false || context === undefined) {
        return response(STARTING_BODY, 503);
      }
      if (metadata.state === 'stopping') {
        acceptedResponseBody ??= acceptedBody(metadata);
        return response(acceptedResponseBody, 202);
      }
      if (!accepted) {
        accepted = true;
        let notified = false;
        context.onResponseSettled(() => {
          if (notified) return;
          notified = true;
          return options.onShutdownRequested();
        }, options.onShutdownError);
      }
      acceptedResponseBody ??= acceptedBody(metadata);
      return response(acceptedResponseBody, 202);
    },
  };
}

export type DaemonShutdownControl = DaemonShutdownHandler;
