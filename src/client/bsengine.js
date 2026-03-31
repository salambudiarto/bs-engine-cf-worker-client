/**
 * BSEngine TCP Client
 *
 * Sends a single BSEngine binary request over a fresh TCP connection
 * and returns the parsed response. One connection per request is the
 * correct model for Cloudflare Workers: the runtime does not support
 * persistent connection pools across Worker invocations.
 *
 * Transport: `cloudflare:sockets` — Cloudflare's raw TCP API.
 * Reference:  https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/
 *
 * Flow per call:
 *   1. Open TCP socket to BSEngine host:port
 *   2. Write binary request frame
 *   3. Read 11-byte response header
 *   4. Validate response magic
 *   5. Read `dataLen` response body bytes
 *   6. Close socket
 *   7. Return { status, data }
 */

import { connect } from 'cloudflare:sockets';

import { BSENGINE_HOST, BSENGINE_PORT } from '../config.js';
import { MAGIC, RESPONSE_HEADER_SIZE }  from '../protocol/constants.js';
import { buildFrame, parseResponseHeader } from '../protocol/frame.js';
import { ExactReader }                  from './stream.js';

/**
 * @typedef {Object} BSEngineResponse
 * @property {number}     status — Status byte (Status.OK | Status.NOT_FOUND | Status.ERROR)
 * @property {Uint8Array} data   — Response body bytes (may be empty)
 */

/**
 * Sends one BSEngine command and awaits its response.
 *
 * @param {number}      op        — Opcode (use Op.* from protocol/constants.js)
 * @param {Uint8Array}  keyBytes  — Raw key bytes (1–64 bytes)
 * @param {Uint8Array}  [valBytes] — Raw value bytes (default: empty Uint8Array)
 * @returns {Promise<BSEngineResponse>}
 * @throws {Error} On TCP connection failure, protocol error, or stream closure
 */
export async function sendCommand(op, keyBytes, valBytes = new Uint8Array(0)) {
  const { frame } = buildFrame(op, keyBytes, valBytes);

  // ── 1. Open TCP socket ────────────────────────────────────────────────
  const socket = connect({
    hostname : BSENGINE_HOST,
    port     : BSENGINE_PORT,
  });

  try {
    // ── 2. Write request frame ────────────────────────────────────────────
    const writer = socket.writable.getWriter();
    await writer.write(frame);
    writer.releaseLock();

    // ── 3–5. Read response ────────────────────────────────────────────────
    const reader = new ExactReader(socket.readable.getReader());

    const rawHeader = await reader.readExact(RESPONSE_HEADER_SIZE);
    const header    = parseResponseHeader(rawHeader);

    // ── 4. Validate magic ─────────────────────────────────────────────────
    if (header.magic !== MAGIC) {
      throw new Error(
        `BSEngine: unexpected response magic 0x${header.magic.toString(16).padStart(4, '0')} ` +
        `(expected 0x${MAGIC.toString(16)})`
      );
    }

    // ── 5. Read body ──────────────────────────────────────────────────────
    const data = header.dataLen > 0
      ? await reader.readExact(header.dataLen)
      : new Uint8Array(0);

    return { status: header.status, data };

  } finally {
    // ── 6. Always close the socket ────────────────────────────────────────
    // `close()` is fire-and-forget; errors here are non-fatal.
    socket.close().catch(() => {});
  }
}
