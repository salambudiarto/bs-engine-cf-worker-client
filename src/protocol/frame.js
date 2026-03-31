/**
 * BSEngine Binary Frame — Builder & Parser
 *
 * Implements the BSEngine wire protocol (§3, full-doc.md).
 * All multi-byte integers are little-endian (LE) as required by the spec.
 *
 * Request frame layout (§3.1):
 *   Offset  Size  Field
 *   ──────────────────────────────────────────────────
 *   0       2     Magic    — 0xBE57 LE
 *   2       1     Op       — opcode byte
 *   3       4     ReqID    — LE uint32, echoed in response
 *   7       1     KeyLen   — key length in bytes (1–64)
 *   8       4     ValLen   — value length in bytes (0–10485760) LE
 *   12      N     Key      — raw key bytes
 *   12+N    M     Val      — raw value bytes
 *
 * Response frame layout (§3.2):
 *   Offset  Size  Field
 *   ──────────────────────────────────────────────────
 *   0       2     Magic    — 0xBE57 LE
 *   2       4     ReqID    — echoed from request LE
 *   6       1     Status   — 0x00 Ok | 0x01 NotFound | 0x02 Error
 *   7       4     DataLen  — response body length LE
 *   11      N     Data     — response body bytes
 */

import { MAGIC, REQUEST_HEADER_SIZE } from './constants.js';

// ── Request ID counter ─────────────────────────────────────────────────────
// A simple monotonic counter provides unique-per-lifetime correlation IDs.
// It wraps at 2^32 (>>> 0 coerces to unsigned 32-bit on overflow).
let _reqCounter = 0;

/** Returns a unique, monotonically increasing 32-bit unsigned request ID. */
function nextReqId() {
  _reqCounter = (_reqCounter + 1) >>> 0;
  return _reqCounter;
}

// ── Frame builder ──────────────────────────────────────────────────────────

/**
 * Builds a complete BSEngine binary request frame.
 *
 * @param {number}     op        — operation opcode (use Op.* from constants.js)
 * @param {Uint8Array} keyBytes  — encoded key bytes (1–64 bytes)
 * @param {Uint8Array} [valBytes] — encoded value bytes (default: empty)
 * @returns {{ frame: Uint8Array, reqId: number }}
 */
export function buildFrame(op, keyBytes, valBytes = new Uint8Array(0)) {
  const totalLen = REQUEST_HEADER_SIZE + keyBytes.length + valBytes.length;
  const buf      = new Uint8Array(totalLen);
  const view     = new DataView(buf.buffer);
  const reqId    = nextReqId();

  // Header
  view.setUint16(0, MAGIC, /* littleEndian= */ true);
  buf[2] = op;
  view.setUint32(3, reqId, true);
  buf[7] = keyBytes.length;
  view.setUint32(8, valBytes.length, true);

  // Payload
  buf.set(keyBytes, REQUEST_HEADER_SIZE);
  buf.set(valBytes, REQUEST_HEADER_SIZE + keyBytes.length);

  return { frame: buf, reqId };
}

// ── Response parser ────────────────────────────────────────────────────────

/**
 * Parses the fixed 11-byte response header.
 *
 * @param {Uint8Array} bytes — exactly 11 bytes from the TCP stream
 * @returns {{ magic: number, reqId: number, status: number, dataLen: number }}
 */
export function parseResponseHeader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  return {
    magic  : view.getUint16(0, true),
    reqId  : view.getUint32(2, true),
    status : bytes[6],
    dataLen: view.getUint32(7, true),
  };
}
