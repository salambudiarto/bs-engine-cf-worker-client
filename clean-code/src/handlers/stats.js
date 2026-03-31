/**
 * Stats Handler — GET /stats
 *
 * Sends an OpStats frame to BSEngine and returns engine health metrics.
 *
 * BSEngine OpStats response layout (main.go §[C.3] / full-doc §3.5):
 *   Offset  Size  Field
 *   ──────────────────────────────────────
 *   0       8     Total live keys in index (LE uint64)
 *   8       8     Total ops since last checkpoint (LE uint64)
 *   16      8     Total pages in data file (LE uint64)
 *
 * Note: Values are uint64 on the wire. JavaScript's Number type can represent
 * integers up to 2^53 − 1 safely. For engines with >9 petabytes of data or
 * >9 quadrillion ops, switch the JSON serialisation to BigInt strings.
 */

import { sendCommand }  from '../client/bsengine.js';
import { Op, Status, STATS_BODY_SIZE } from '../protocol/constants.js';
import { jsonResponse, upstreamError, connectionError } from '../utils/http.js';

/** Dummy key — OpStats ignores the key but KeyLen must be 1–64. */
const STATS_KEY = new Uint8Array([0x5f]); // '_'

/**
 * @returns {Promise<Response>}
 */
export async function handleStats() {
  try {
    const { status, data } = await sendCommand(Op.STATS, STATS_KEY);

    if (status !== Status.OK) {
      return upstreamError('Stats');
    }
    if (data.length < STATS_BODY_SIZE) {
      return upstreamError('Stats (truncated response)');
    }

    const view = new DataView(data.buffer, data.byteOffset);

    return jsonResponse({
      keys      : Number(view.getBigUint64(0,  /* littleEndian= */ true)),
      totalOps  : Number(view.getBigUint64(8,  true)),
      totalPages: Number(view.getBigUint64(16, true)),
    });

  } catch (err) {
    return connectionError(err.message);
  }
}
