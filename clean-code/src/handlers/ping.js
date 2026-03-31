/**
 * Ping Handler — GET /ping
 *
 * Sends an OpPing frame to BSEngine and returns a 200 response on success.
 * Use this as a liveness check or latency probe.
 *
 * BSEngine OpPing behaviour (main.go):
 *   - Server reads and discards the key; sends Status OK with DataLen = 0.
 *   - A dummy single-byte key '_' satisfies the 1–64 byte key length constraint.
 */

import { sendCommand }   from '../client/bsengine.js';
import { Op, Status }   from '../protocol/constants.js';
import { jsonResponse, upstreamError, connectionError } from '../utils/http.js';

/** Dummy key sent with OpPing — BSEngine requires KeyLen ≥ 1. */
const PING_KEY = new Uint8Array([0x5f]); // '_'

/**
 * @returns {Promise<Response>}
 */
export async function handlePing() {
  try {
    const { status } = await sendCommand(Op.PING, PING_KEY);

    if (status === Status.OK) {
      return jsonResponse({ ok: true, message: 'BSEngine is reachable' });
    }
    return upstreamError('Ping');

  } catch (err) {
    return connectionError(err.message);
  }
}
