/**
 * Delete Handler — DELETE /keys/:key
 *
 * Removes the entry at `key` from BSEngine via OpDelete.
 *
 * BSEngine OpDelete behaviour (main.go §OpDelete):
 *   - OK (0x00)        → key deleted; DataLen = 0 in response
 *   - NOT_FOUND (0x01) → key did not exist
 *   - ERROR (0x02)     → server-side failure; check BSEngine logs
 *
 * HTTP semantics: returning 404 when the key does not exist follows REST
 * convention and lets callers distinguish "was there" from "never existed".
 * If idempotent delete (always 200) is preferred, change NOT_FOUND to
 * return jsonResponse({ deleted: false, key }).
 */

import { sendCommand }  from '../client/bsengine.js';
import { Op, Status }  from '../protocol/constants.js';
import { validateKey, encodeKey }  from '../utils/validate.js';
import { jsonResponse, badRequest, keyNotFound, upstreamError, connectionError }
  from '../utils/http.js';

/**
 * @param {string} key — decoded URL segment from the router
 * @returns {Promise<Response>}
 */
export async function handleDelete(key) {
  const keyErr = validateKey(key);
  if (keyErr) return badRequest(keyErr);

  try {
    const { status } = await sendCommand(Op.DELETE, encodeKey(key));

    switch (status) {
      case Status.OK:        return jsonResponse({ deleted: true, key });
      case Status.NOT_FOUND: return keyNotFound(key);
      default:               return upstreamError('Delete');
    }

  } catch (err) {
    return connectionError(err.message);
  }
}
