export const DAEMON_METADATA_SCHEMA = 'bungee-daemon-metadata-v1' as const;
export const DAEMON_METADATA_MAX_BYTES = 4 * 1024;
export const DAEMON_SHUTDOWN_PATH = '/__bungee/internal/daemon/v1/shutdown' as const;
export const DAEMON_CONTROL_HTTP_PREFIX = '/__bungee/internal/daemon/' as const;
export const DAEMON_AUTHORIZATION_HEADER = 'authorization' as const;
export const DAEMON_BOOT_HEADER = 'x-bungee-daemon-boot' as const;
export const DAEMON_INSTANCE_HEADER = 'x-bungee-daemon-instance' as const;
export const DAEMON_PID_HEADER = 'x-bungee-daemon-pid' as const;
export const DAEMON_PROCESS_IDENTITY_MARKER_PREFIX = '--bungee-process-identity=' as const;

type DaemonMetadataBase = {
  readonly schema: typeof DAEMON_METADATA_SCHEMA;
  readonly launcher_pid: number;
  readonly boot_nonce: string;
  readonly executable: string;
  readonly shutdown_secret: string;
  readonly entrypoint: string | null;
};

export type DaemonMetadataLaunching = DaemonMetadataBase & {
  readonly state: 'launching';
  readonly pid: null;
  readonly instance_id: null;
  readonly management_host: null;
  readonly management_port: null;
};

export type DaemonMetadataStarting = DaemonMetadataBase & {
  readonly state: 'starting';
  readonly pid: number;
  readonly instance_id: null;
  readonly management_host: null;
  readonly management_port: null;
};

type DaemonMetadataServing = DaemonMetadataBase & {
  readonly pid: number;
  readonly instance_id: string;
  readonly management_host: '127.0.0.1';
  readonly management_port: number;
};

export type DaemonMetadataArmed = DaemonMetadataServing & { readonly state: 'armed' };
export type DaemonMetadataStopping = DaemonMetadataServing & { readonly state: 'stopping' };
export type DaemonMetadataV1 =
  | DaemonMetadataLaunching
  | DaemonMetadataStarting
  | DaemonMetadataArmed
  | DaemonMetadataStopping;
export type DaemonMetadataState = DaemonMetadataV1['state'];

export type DaemonMetadataCodecErrorCode =
  | 'invalid_metadata'
  | 'duplicate_key'
  | 'unknown_field'
  | 'missing_field'
  | 'invalid_utf8'
  | 'message_too_large';

export class DaemonMetadataCodecError extends Error {
  readonly name = 'DaemonMetadataCodecError';

  constructor(readonly code: DaemonMetadataCodecErrorCode, message: string = code) {
    super(message);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE64URL = /^[A-Za-z0-9_-]{43}$/;
const METADATA_FIELDS = [
  'schema', 'state', 'launcher_pid', 'boot_nonce', 'shutdown_secret', 'executable', 'entrypoint',
  'pid', 'instance_id', 'management_host', 'management_port',
] as const;

function fail(code: DaemonMetadataCodecErrorCode, message: string): never {
  throw new DaemonMetadataCodecError(code, message);
}

function utf8ByteLength(value: string): number {
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) length += 1;
    else if (code < 0x800) length += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length
      && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      length += 4;
      index += 1;
    } else length += 3;
  }
  return length;
}

function decodeUtf8(bytes: Uint8Array): string {
  let result = '';
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index++];
    if (first < 0x80) {
      result += String.fromCharCode(first);
      continue;
    }
    const count = first >= 0xf0 ? 3 : first >= 0xe0 ? 2 : 1;
    if (index + count > bytes.length) fail('invalid_utf8', 'metadata is not valid UTF-8');
    let code = first & (count === 3 ? 0x07 : count === 2 ? 0x0f : 0x1f);
    for (let part = 0; part < count; part += 1) {
      const next = bytes[index++];
      if ((next & 0xc0) !== 0x80) fail('invalid_utf8', 'metadata is not valid UTF-8');
      code = (code << 6) | (next & 0x3f);
    }
    if ((count === 1 && code < 0x80) || (count === 2 && code < 0x800)
      || (count === 3 && code < 0x10000) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      fail('invalid_utf8', 'metadata is not valid UTF-8');
    }
    if (code <= 0xffff) result += String.fromCharCode(code);
    else {
      const scalar = code - 0x10000;
      result += String.fromCharCode(0xd800 + (scalar >> 10), 0xdc00 + (scalar & 0x3ff));
    }
  }
  return result;
}

function stringEnd(value: string, start: number): number {
  for (let index = start + 1; index < value.length; index += 1) {
    const char = value.charCodeAt(index);
    if (char === 0x22) return index + 1;
    if (char < 0x20) fail('invalid_metadata', 'metadata contains an invalid string');
    if (char === 0x5c) {
      index += 1;
      if (index >= value.length) fail('invalid_metadata', 'metadata contains an invalid escape');
      if (value[index] === 'u') index += 4;
      if (index >= value.length) fail('invalid_metadata', 'metadata contains an invalid escape');
    }
  }
  fail('invalid_metadata', 'metadata contains an unterminated string');
}

function skipWhitespace(value: string, start: number): number {
  let index = start;
  while (index < value.length && /\s/.test(value[index])) index += 1;
  return index;
}

function scanValue(value: string, start: number): number {
  const index = skipWhitespace(value, start);
  if (value[index] === '"') return stringEnd(value, index);
  if (value[index] === '{') {
    let cursor = skipWhitespace(value, index + 1);
    const keys = new Set<string>();
    if (value[cursor] === '}') return cursor + 1;
    while (true) {
      if (value[cursor] !== '"') fail('invalid_metadata', 'object key must be a string');
      const end = stringEnd(value, cursor);
      let key: string;
      try { key = JSON.parse(value.slice(cursor, end)) as string; }
      catch { fail('invalid_metadata', 'object key is not valid JSON'); }
      if (keys.has(key)) fail('duplicate_key', `duplicate object key: ${key}`);
      keys.add(key);
      cursor = skipWhitespace(value, end);
      if (value[cursor] !== ':') fail('invalid_metadata', 'object key is missing a colon');
      cursor = scanValue(value, cursor + 1);
      cursor = skipWhitespace(value, cursor);
      if (value[cursor] === '}') return cursor + 1;
      if (value[cursor] !== ',') fail('invalid_metadata', 'object is missing a comma');
      cursor = skipWhitespace(value, cursor + 1);
    }
  }
  if (value[index] === '[') {
    let cursor = skipWhitespace(value, index + 1);
    if (value[cursor] === ']') return cursor + 1;
    while (true) {
      cursor = scanValue(value, cursor);
      cursor = skipWhitespace(value, cursor);
      if (value[cursor] === ']') return cursor + 1;
      if (value[cursor] !== ',') fail('invalid_metadata', 'array is missing a comma');
      cursor = skipWhitespace(value, cursor + 1);
    }
  }
  let cursor = index;
  while (cursor < value.length && !',]}'.includes(value[cursor]) && !/\s/.test(value[cursor])) cursor += 1;
  if (cursor === index) fail('invalid_metadata', 'metadata contains an invalid value');
  return cursor;
}

function assertNoDuplicateKeys(value: string): void {
  const end = scanValue(value, 0);
  if (skipWhitespace(value, end) !== value.length) fail('invalid_metadata', 'metadata contains trailing data');
}

function base64Value(character: string): number {
  if (character >= 'A' && character <= 'Z') return character.charCodeAt(0) - 65;
  if (character >= 'a' && character <= 'z') return character.charCodeAt(0) - 71;
  if (character >= '0' && character <= '9') return character.charCodeAt(0) + 4;
  if (character === '-') return 62;
  if (character === '_') return 63;
  return -1;
}

function encodeSecret(value: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let result = '';
  for (let index = 0; index < value.length; index += 3) {
    const a = value[index];
    const b = index + 1 < value.length ? value[index + 1] : 0;
    const c = index + 2 < value.length ? value[index + 2] : 0;
    result += alphabet[a >> 2] + alphabet[((a & 3) << 4) | (b >> 4)];
    if (index + 1 < value.length) result += alphabet[((b & 15) << 2) | (c >> 6)];
    if (index + 2 < value.length) result += alphabet[c & 63];
  }
  return result;
}

function decodeSecret(value: string): Uint8Array {
  if (!BASE64URL.test(value)) fail('invalid_metadata', 'shutdown_secret must be canonical base64url');
  const result = new Uint8Array(32);
  let output = 0;
  for (let index = 0; index < value.length; index += 4) {
    const a = base64Value(value[index]);
    const b = base64Value(value[index + 1]);
    const c = index + 2 < value.length ? base64Value(value[index + 2]) : 0;
    const d = index + 3 < value.length ? base64Value(value[index + 3]) : 0;
    if (a < 0 || b < 0 || c < 0 || d < 0) fail('invalid_metadata', 'shutdown_secret must be canonical base64url');
    if (output < 32) result[output++] = (a << 2) | (b >> 4);
    if (output < 32 && index + 2 < value.length) result[output++] = ((b & 15) << 4) | (c >> 2);
    if (output < 32 && index + 3 < value.length) result[output++] = ((c & 3) << 6) | d;
  }
  if (encodeSecret(result) !== value) fail('invalid_metadata', 'shutdown_secret is not canonical base64url');
  return result;
}

export function decodeDaemonShutdownSecret(value: string): Uint8Array {
  return decodeSecret(value);
}

export function encodeDaemonShutdownSecret(value: Uint8Array): string {
  if (value.byteLength !== 32) fail('invalid_metadata', 'shutdown_secret must decode to 32 bytes');
  return encodeSecret(value);
}

function plain(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    fail('invalid_metadata', 'metadata must be a plain object');
  }
  return value as Record<string, unknown>;
}

function exactFields(value: Record<string, unknown>): void {
  const actual = Object.keys(value).sort();
  const expected = [...METADATA_FIELDS].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    const unknown = actual.find((key) => !expected.includes(key as typeof METADATA_FIELDS[number]));
    if (unknown !== undefined) fail('unknown_field', 'metadata fields are not exact');
    fail(actual.length < expected.length ? 'missing_field' : 'invalid_metadata', 'metadata fields are not exact');
  }
}

function stringField(value: Record<string, unknown>, field: string): string {
  if (typeof value[field] !== 'string') fail('invalid_metadata', `${field} must be a string`);
  return value[field] as string;
}

function numberField(value: Record<string, unknown>, field: string): number {
  if (typeof value[field] !== 'number' || !Number.isSafeInteger(value[field])) {
    fail('invalid_metadata', `${field} must be a safe integer`);
  }
  return value[field] as number;
}

function uuidField(value: Record<string, unknown>, field: string): string {
  const result = stringField(value, field);
  if (!UUID.test(result)) fail('invalid_metadata', `${field} must be a canonical lowercase UUID`);
  return result;
}

function absolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

function entrypointField(value: Record<string, unknown>): string | null {
  const entrypoint = value.entrypoint;
  if (entrypoint === null) return null;
  if (typeof entrypoint !== 'string' || entrypoint.length === 0 || entrypoint.trim() !== entrypoint
    || entrypoint.includes('\0') || !absolutePath(entrypoint)) {
    fail('invalid_metadata', 'entrypoint must be null or an absolute non-empty path');
  }
  return entrypoint;
}

function nullField(value: Record<string, unknown>, field: string): null {
  if (value[field] !== null) fail('invalid_metadata', `${field} must be null for this state`);
  return null;
}

function positivePid(value: Record<string, unknown>, field: string): number {
  const result = numberField(value, field);
  if (result <= 0) fail('invalid_metadata', `${field} must be positive`);
  return result;
}

function managementPort(value: Record<string, unknown>): number {
  const result = numberField(value, 'management_port');
  if (result < 1 || result > 65_535) fail('invalid_metadata', 'management_port must be a valid TCP port');
  return result;
}

function managementHost(value: Record<string, unknown>): '127.0.0.1' {
  const result = stringField(value, 'management_host');
  if (result !== '127.0.0.1') fail('invalid_metadata', 'management_host must be 127.0.0.1');
  return result;
}

function validate(value: unknown): DaemonMetadataV1 {
  const input = plain(value);
  exactFields(input);
  const schema = stringField(input, 'schema');
  const state = stringField(input, 'state');
  const launcherPid = positivePid(input, 'launcher_pid');
  const bootNonce = uuidField(input, 'boot_nonce');
  const executable = stringField(input, 'executable');
  const secret = stringField(input, 'shutdown_secret');
  const entrypoint = entrypointField(input);
  if (schema !== DAEMON_METADATA_SCHEMA) fail('invalid_metadata', 'schema is unsupported');
  if (executable.length === 0 || executable.trim() !== executable || executable.includes('\0')) {
    fail('invalid_metadata', 'executable must be a non-empty unpadded string');
  }
  decodeSecret(secret);
  const base = {
    schema: DAEMON_METADATA_SCHEMA,
    launcher_pid: launcherPid,
    boot_nonce: bootNonce,
    executable,
    shutdown_secret: secret,
    entrypoint,
  } satisfies DaemonMetadataBase;
  let result: DaemonMetadataV1;
  if (state === 'launching') {
    result = Object.freeze({
      ...base, state, pid: nullField(input, 'pid'), instance_id: nullField(input, 'instance_id'),
      management_host: nullField(input, 'management_host'), management_port: nullField(input, 'management_port'),
    });
  } else if (state === 'starting') {
    result = Object.freeze({
      ...base, state, pid: positivePid(input, 'pid'), instance_id: nullField(input, 'instance_id'),
      management_host: nullField(input, 'management_host'), management_port: nullField(input, 'management_port'),
    });
  } else if (state === 'armed' || state === 'stopping') {
    result = Object.freeze({
      ...base, state, pid: positivePid(input, 'pid'), instance_id: uuidField(input, 'instance_id'),
      management_host: managementHost(input), management_port: managementPort(input),
    });
  } else {
    fail('invalid_metadata', 'state is invalid');
  }
  if (utf8ByteLength(JSON.stringify(result)) > DAEMON_METADATA_MAX_BYTES) {
    fail('message_too_large', 'daemon metadata exceeds 4 KiB');
  }
  return result;
}

export function validateDaemonMetadataV1(value: unknown): DaemonMetadataV1 {
  return validate(value);
}

export function decodeDaemonMetadataV1(value: string | Uint8Array): DaemonMetadataV1 {
  if (value instanceof Uint8Array && value.byteLength > DAEMON_METADATA_MAX_BYTES) {
    fail('message_too_large', 'daemon metadata exceeds 4 KiB');
  }
  const text = typeof value === 'string' ? value : decodeUtf8(value);
  if (utf8ByteLength(text) > DAEMON_METADATA_MAX_BYTES) fail('message_too_large', 'daemon metadata exceeds 4 KiB');
  try {
    assertNoDuplicateKeys(text);
    return validate(JSON.parse(text));
  } catch (error) {
    if (error instanceof DaemonMetadataCodecError) throw error;
    fail('invalid_metadata', 'metadata is not valid JSON');
  }
}

export function encodeDaemonMetadataV1(value: DaemonMetadataV1): string {
  const metadata = validate(value);
  const result = JSON.stringify(metadata);
  if (utf8ByteLength(result) > DAEMON_METADATA_MAX_BYTES) fail('message_too_large', 'daemon metadata exceeds 4 KiB');
  return result;
}

export const parseDaemonMetadataV1 = decodeDaemonMetadataV1;
export const serializeDaemonMetadataV1 = encodeDaemonMetadataV1;
