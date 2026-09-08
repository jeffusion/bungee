import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ENVELOPE_VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

export type SecretKeyMaterial = Readonly<{
  readonly keyId: string;
  readonly key: Uint8Array;
}>;

export class SecretCryptoError extends Error {
  readonly name = 'SecretCryptoError';

  constructor(readonly code: 'invalid_key' | 'invalid_envelope' | 'key_mismatch' | 'authentication_failed') {
    super(code);
  }
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function uint16(value: number): Uint8Array {
  const result = new Uint8Array(2);
  new DataView(result.buffer).setUint16(0, value, false);
  return result;
}

function uint32(value: number): Uint8Array {
  const result = new Uint8Array(4);
  new DataView(result.buffer).setUint32(0, value, false);
  return result;
}

function uint64(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_SAFE_INTEGER) {
    throw new SecretCryptoError('invalid_envelope');
  }
  const result = new Uint8Array(8);
  new DataView(result.buffer).setBigUint64(0, BigInt(value), false);
  return result;
}

function lengthPrefixed(value: string): Uint8Array {
  const bytes = utf8(value);
  return concat(uint32(bytes.length), bytes);
}

export function encodeSecretAad(namespace: string, key: string, version: number, namespaceEpoch: number): Uint8Array {
  return concat(
    Uint8Array.of(ENVELOPE_VERSION),
    lengthPrefixed(namespace),
    lengthPrefixed(key),
    uint64(version),
    uint64(namespaceEpoch),
  );
}

export function validateKeyMaterial(material: SecretKeyMaterial): Uint8Array {
  if (typeof material.keyId !== 'string' || material.keyId.length === 0) {
    throw new SecretCryptoError('invalid_key');
  }
  const keyId = utf8(material.keyId);
  if (keyId.length > 0xffff || !(material.key instanceof Uint8Array) || material.key.length !== 32) {
    throw new SecretCryptoError('invalid_key');
  }
  return keyId;
}

export function encryptSecret(
  value: string,
  namespace: string,
  key: string,
  version: number,
  namespaceEpoch: number,
  material: SecretKeyMaterial,
): Uint8Array {
  const keyId = validateKeyMaterial(material);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(material.key), nonce);
  cipher.setAAD(Buffer.from(encodeSecretAad(namespace, key, version, namespaceEpoch)));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return concat(
    Uint8Array.of(ENVELOPE_VERSION),
    uint16(keyId.length),
    keyId,
    nonce,
    tag,
    ciphertext,
  );
}

export function decryptSecret(
  envelope: Uint8Array,
  namespace: string,
  key: string,
  version: number,
  namespaceEpoch: number,
  material: SecretKeyMaterial,
): string {
  const keyId = validateKeyMaterial(material);
  if (!(envelope instanceof Uint8Array) || envelope.length < 1 + 2 + NONCE_BYTES + TAG_BYTES) {
    throw new SecretCryptoError('invalid_envelope');
  }
  const view = new DataView(envelope.buffer, envelope.byteOffset, envelope.byteLength);
  const envelopeVersion = view.getUint8(0);
  const keyIdLength = view.getUint16(1, false);
  const headerLength = 1 + 2 + keyIdLength + NONCE_BYTES + TAG_BYTES;
  if (envelopeVersion !== ENVELOPE_VERSION || keyIdLength === 0 || envelope.length < headerLength) {
    throw new SecretCryptoError('invalid_envelope');
  }
  const envelopeKeyId = envelope.subarray(3, 3 + keyIdLength);
  if (envelopeKeyId.length !== keyId.length || envelopeKeyId.some((byte, index) => byte !== keyId[index])) {
    throw new SecretCryptoError('key_mismatch');
  }
  const nonceStart = 3 + keyIdLength;
  const tagStart = nonceStart + NONCE_BYTES;
  const nonce = envelope.subarray(nonceStart, tagStart);
  const tag = envelope.subarray(tagStart, headerLength);
  const ciphertext = envelope.subarray(headerLength);
  try {
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(material.key), Buffer.from(nonce));
    decipher.setAAD(Buffer.from(encodeSecretAad(namespace, key, version, namespaceEpoch)));
    decipher.setAuthTag(Buffer.from(tag));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext)), decipher.final()]);
    return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
  } catch {
    throw new SecretCryptoError('authentication_failed');
  }
}
