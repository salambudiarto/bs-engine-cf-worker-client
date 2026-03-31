/**
 * View Handler — GET /keys/:key
 *
 * Retrieves the value stored at `key` from BSEngine via OpView.
 *
 * Response body:
 *   The raw bytes stored by BSEngine are returned as-is with
 *   Content-Type: application/octet-stream. Clients that stored UTF-8
 *   text can interpret the bytes as a string; clients that stored binary
 *   data receive the binary directly.
 *
 * BSEngine OpView behaviour (main.go §OpView):
 *   - OK (0x00)        → DataLen = stored value size; Data = value bytes
 *   - NOT_FOUND (0x01) → DataLen = 0
 *   - ERROR (0x02)     → server-side failure; check BSEngine logs
 */

import { sendCommand }  from '../client/bsengine.js';
import { Op, Status }  from '../protocol/constants.js';
import { validateKey, encodeKey }  from '../utils/validate.js';
import { bytesResponse, badRequest, keyNotFound, upstreamError, connectionError }
  from '../utils/http.js';

/**
 * @param {string} key — decoded URL segment from the router
 * @returns {Promise<Response>}
 */
export async function handleView(key) {
  const keyErr = validateKey(key);
  if (keyErr) return badRequest(keyErr);

  try {
    const { status, data } = await sendCommand(Op.VIEW, encodeKey(key));

    switch (status) {
      case Status.OK:        return bytesResponse(data);
      case Status.NOT_FOUND: return keyNotFound(key);
      default:               return upstreamError('View');
    }

  } catch (err) {
    return connectionError(err.message);
  }
}
