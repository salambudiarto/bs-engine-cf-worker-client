/**
 * Incr Handler — POST /keys/:key/incr
 *
 * Atomically increments the int64 counter stored at `key` by `delta`.
 * If the key does not exist, BSEngine initialises it to 0 before applying
 * the delta (equivalent to Upsert(key, 0) + Incr under a single lock).
 *
 * Request body (JSON):
 *   { "delta": <integer> }   — positive or negative integer; default 1
 *
 * Response body (JSON):
 *   { "key": "...", "newValue": <integer> }
 *
 * BSEngine OpIncr wire details (main.go §OpIncr / full-doc §3.3):
 *   Request  ValLen = 8: LE int64 delta
 *   Response DataLen = 8: LE int64 new value
 *
 * Note on BigInt: The delta and new value are serialised as 64-bit signed
 * integers. JavaScript's `Number` handles values up to ±2^53 accurately;
 * counters in that range are returned as plain JSON numbers. If your use
 * case needs counters beyond ±9007199254740991, change the JSON output to
 * a string (newVal.toString()) and document accordingly.
 */

import { sendCommand }  from '../client/bsengine.js';
import { Op, Status, INCR_BODY_SIZE } from '../protocol/constants.js';
import { validateKey, encodeKey }  from '../utils/validate.js';
import { jsonResponse, badRequest, upstreamError, connectionError }
  from '../utils/http.js';

/**
 * @param {string}  key     — decoded URL segment from the router (without '/incr')
 * @param {Request} request — incoming HTTP request (JSON body with delta)
 * @returns {Promise<Response>}
 */
export async function handleIncr(key, request) {
  // ── Validate key ────────────────────────────────────────────────────────
  const keyErr = validateKey(key);
  if (keyErr) return badRequest(keyErr);

  // ── Parse delta from request body ───────────────────────────────────────
  let delta;
  try {
    const body = await request.json();
    // Default to 1 when delta is omitted
    const raw = body.delta !== undefined ? body.delta : 1;
    delta = BigInt(Math.trunc(Number(raw)));
  } catch {
    return badRequest('Body must be valid JSON, e.g. {"delta": 1} or {"delta": -5}');
  }

  // ── Encode delta as 8-byte LE int64 ────────────────────────────────────
  const valBytes = new Uint8Array(INCR_BODY_SIZE);
  new DataView(valBytes.buffer).setBigInt64(0, delta, /* littleEndian= */ true);

  try {
    const { status, data } = await sendCommand(Op.INCR, encodeKey(key), valBytes);

    if (status !== Status.OK) {
      return upstreamError('Incr');
    }
    if (data.length < INCR_BODY_SIZE) {
      return upstreamError('Incr (truncated response)');
    }

    const newVal = new DataView(data.buffer, data.byteOffset)
      .getBigInt64(0, /* littleEndian= */ true);

    return jsonResponse({ key, newValue: Number(newVal) });

  } catch (err) {
    return connectionError(err.message);
  }
}
