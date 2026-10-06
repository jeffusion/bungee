/**
 * Plugin peer channel binary frame codec (P4).
 *
 * STRUCTURE ONLY — this module is a pure, deterministic framing codec. It packs
 * an already-authenticated {@link PluginPeerPacket} into one bounded WebSocket
 * binary message and unpacks it again.
 *
 * It does NOT authenticate anything. `decodePluginPeerFrame` proves only that a
 * byte string is structurally a well-formed frame with a syntactic header and a
 * bounded body. It never proves a MAC, a peer identity, a direction, a
 * controller authority, or that a sequence is fresh. A receiver MUST:
 *   1. `decodePluginPeerFrame(frame)`, then
 *   2. `verifyPluginPeerPacket(header, body, credential, expected)`, then
 *   3. `PluginPeerReplayWindow.accept(header.sequence)`,
 * before dispatching. Structure is never admission.
 *
 * Wire format (every integer is unsigned big-endian, 12-byte prefix):
 *   offset 0  uint32  magic         0x42504331 ("BPC1")
 *   offset 4  uint32  headerLength  raw canonical UTF-8 JSON header bytes
 *   offset 8  uint32  bodyLength    raw body bytes
 *   offset 12 headerLength header bytes, then bodyLength body bytes
 *
 * Exactly one frame per WebSocket binary message. Frames are never split across
 * messages and multiple packets are never concatenated into one message. The
 * header budget ({@link PEER_HEADER_MAX_BYTES}) and the body budget
 * ({@link PEER_BODY_MAX_BYTES}) stay independent; a multi-megabyte payload never
 * rides one frame, never rides the old 64 KiB control RPC envelope, and is
 * streamed as a sequence of these same bounded frames by a later layer.
 *
 * The codec allocates nothing before validating every declared length: an
 * oversized `headerLength`/`bodyLength` is rejected before any slice or parse,
 * and the declared lengths must sum to the exact frame length (no truncation,
 * no ignored suffix).
 */
import {
  PEER_BODY_MAX_BYTES,
  PEER_HEADER_MAX_BYTES,
  PluginPeerProtocolError,
  decodePluginPeerHeader,
  encodePluginPeerHeader,
  type PluginPeerPacket,
} from './peer-protocol';

/** Fixed 12-byte frame prefix: uint32BE magic, headerLength, bodyLength. */
export const PEER_FRAME_PREFIX_BYTES = 12;

/** Largest legal frame: prefix + max metadata header + max body (73740 bytes). */
export const PEER_FRAME_MAX_BYTES = PEER_FRAME_PREFIX_BYTES + PEER_HEADER_MAX_BYTES + PEER_BODY_MAX_BYTES;

/** `"BPC1"` big-endian: the codec's frozen protocol tag. */
const FRAME_MAGIC = 0x42504331;

function fail(code: 'malformed_message' | 'size_limit', message: string): never {
  throw new PluginPeerProtocolError(code, message);
}

function malformed(message: string): never {
  return fail('malformed_message', message);
}

/**
 * Accepts only binary carriers. A string, number, `null`, plain object, or
 * `DataView` is a fixed, payload-free `malformed_message`, never a coercion.
 */
function toFrameBytes(frame: Uint8Array | ArrayBuffer): Uint8Array {
  if (frame instanceof Uint8Array) return frame;
  if (frame instanceof ArrayBuffer) return new Uint8Array(frame);
  return malformed('peer frame must be binary');
}

/**
 * Frames one packet as a single bounded buffer.
 *
 * The header bytes are the raw canonical UTF-8 JSON — recovered by decoding the
 * canonical base64url that {@link encodePluginPeerHeader} produces — so the 8 KiB
 * budget is measured against the JSON bytes, never against the base64url text.
 * The body is validated against the 64 KiB budget and copied into the frame, so
 * a later caller mutation of the packet body cannot change an encoded frame.
 */
export function encodePluginPeerFrame(packet: PluginPeerPacket): Uint8Array {
  if (packet === null || typeof packet !== 'object') {
    return malformed('peer frame packet must be an object');
  }
  const headerBytes = new Uint8Array(Buffer.from(encodePluginPeerHeader(packet.header), 'base64url'));
  if (headerBytes.byteLength > PEER_HEADER_MAX_BYTES) {
    return fail('size_limit', 'peer frame header exceeds the metadata byte limit');
  }
  const body = packet.body;
  if (!(body instanceof Uint8Array)) {
    return malformed('peer frame body must be a Uint8Array');
  }
  if (body.byteLength > PEER_BODY_MAX_BYTES) {
    return fail('size_limit', 'peer frame body exceeds the frame byte limit');
  }
  const frame = new Uint8Array(PEER_FRAME_PREFIX_BYTES + headerBytes.byteLength + body.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, FRAME_MAGIC, false);
  view.setUint32(4, headerBytes.byteLength, false);
  view.setUint32(8, body.byteLength, false);
  frame.set(headerBytes, PEER_FRAME_PREFIX_BYTES);
  frame.set(body, PEER_FRAME_PREFIX_BYTES + headerBytes.byteLength);
  return frame;
}

/**
 * Unpacks one bounded frame. Structural only: the returned packet is
 * unauthenticated and MUST be verified by the caller.
 *
 * Every declared length is bounded before any allocation or parsing, and the
 * declared lengths must account for the exact frame length. A `Uint8Array` view
 * is honoured through its `byteOffset`/`byteLength`, and the header is decoded by
 * the peer-protocol codec so its fatal-UTF-8 and canonical-JSON/byte-bound rules
 * are reused rather than re-implemented.
 *
 * The returned packet object is frozen and its body is an independent copy, so
 * mutating the source frame after decoding cannot change the payload that was
 * (or will be) verified. The copy is a defensive boundary, not immutability:
 * the body is a normal `Uint8Array` whose bytes the receiver may still write.
 */
export function decodePluginPeerFrame(frame: Uint8Array | ArrayBuffer): PluginPeerPacket {
  const bytes = toFrameBytes(frame);
  const length = bytes.byteLength;
  if (length > PEER_FRAME_MAX_BYTES) {
    return fail('size_limit', 'peer frame exceeds the frame byte limit');
  }
  if (length < PEER_FRAME_PREFIX_BYTES) {
    return malformed('peer frame is shorter than its prefix');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, false) !== FRAME_MAGIC) {
    return malformed('peer frame magic is invalid');
  }
  const headerLength = view.getUint32(4, false);
  const bodyLength = view.getUint32(8, false);
  if (headerLength === 0) {
    return malformed('peer frame header length must be positive');
  }
  if (headerLength > PEER_HEADER_MAX_BYTES) {
    return fail('size_limit', 'peer frame header exceeds the metadata byte limit');
  }
  if (bodyLength > PEER_BODY_MAX_BYTES) {
    return fail('size_limit', 'peer frame body exceeds the frame byte limit');
  }
  if (length !== PEER_FRAME_PREFIX_BYTES + headerLength + bodyLength) {
    return malformed('peer frame length does not match its declared lengths');
  }
  const headerStart = PEER_FRAME_PREFIX_BYTES;
  const bodyStart = headerStart + headerLength;
  const header = decodePluginPeerHeader(Buffer.from(bytes.subarray(headerStart, bodyStart)).toString('base64url'));
  const body = new Uint8Array(bytes.subarray(bodyStart));
  return Object.freeze({ header, body });
}
