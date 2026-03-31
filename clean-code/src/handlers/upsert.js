/**
 * Upsert Handler — PUT /keys/:key
 *
 * Creates or overwrites the value at `key` in BSEngine via OpUpsert.
 *
 * Request body:
 *   Raw bytes (any Content-Type). Text, JSON, or binary — BSEngine stores
 *   them without interpretation. The body is forwarded verbatim as the
 *   value payload in the binary frame.
 *
 * BSEngine OpUpsert behaviour (main.go §OpUpsert):
 *   - OK (0x00)    → value stored; DataLen = 0 in response
 *   - ERROR (0x02) → write failed (e.g. pool exhausted); check BSEngine logs
 */

import { sendCommand }  from '../client/bsengine.js';
import { Op, Status }  from '../protocol/constants.js';
import { validateKey, validateValueSize, encodeKey } from '../utils/validate.js';
import { jsonResponse, badRequest, upstreamError, connectionError }
  from '../utils/http.js';

/**
 * @param {string}  key     — decoded URL segment from the router
 * @param {Request} request — incoming HTTP request (body = value bytes)
 * @returns {Promise<Response>}
 */
export async function handleUpsert(key, request) {
  // ── Validate key ────────────────────────────────────────────────────────
  const keyErr = validateKey(key);
  if (keyErr) return badRequest(keyErr);

  // ── Read and validate body ──────────────────────────────────────────────
  const body = await request.arrayBuffer();
  const valErr = validateValueSize(body.byteLength);
  if (valErr) return badRequest(valErr);

  const valBytes = new Uint8Array(body);

  try {
    const { status } = await sendCommand(Op.UPSERT, encodeKey(key), valBytes);

    if (status === Status.OK) {
      return jsonResponse({ stored: true, key, bytes: valBytes.length });
    }
    return upstreamError('Upsert');

  } catch (err) {
    return connectionError(err.message);
  }
}
