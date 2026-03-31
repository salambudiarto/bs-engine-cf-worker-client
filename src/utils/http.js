/**
 * HTTP Response Utilities
 *
 * Centralised factory functions for every HTTP response type used by the
 * handlers. Keeping all status codes, headers, and body shapes here ensures
 * a consistent API surface across every endpoint.
 */

const HEADERS_JSON  = { 'Content-Type': 'application/json' };
const HEADERS_BYTES = { 'Content-Type': 'application/octet-stream' };

// ── Success responses ──────────────────────────────────────────────────────

/**
 * 200 OK — JSON body.
 * @param {object} body
 * @param {number} [status=200]
 */
export const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: HEADERS_JSON });

/**
 * 200 OK — Raw binary body (application/octet-stream).
 * Used for OpView responses where the stored value may be arbitrary bytes.
 * @param {Uint8Array} data
 */
export const bytesResponse = (data) =>
  new Response(data, { status: 200, headers: HEADERS_BYTES });

// ── Client error responses ─────────────────────────────────────────────────

/**
 * 400 Bad Request — validation failure with a human-readable message.
 * @param {string} message
 */
export const badRequest = (message) =>
  jsonResponse({ error: 'Bad Request', message }, 400);

/**
 * 404 Not Found — key does not exist in BSEngine.
 * @param {string} key
 */
export const keyNotFound = (key) =>
  jsonResponse({ error: 'Not Found', key }, 404);

// ── Server / upstream error responses ─────────────────────────────────────

/**
 * 502 Bad Gateway — BSEngine returned a non-OK status.
 * @param {string} operation — name of the failing opcode (e.g. 'View')
 */
export const upstreamError = (operation) =>
  jsonResponse({ error: `BSEngine ${operation} operation failed` }, 502);

/**
 * 503 Service Unavailable — TCP connection to BSEngine could not be established.
 * @param {string} detail — low-level error message
 */
export const connectionError = (detail) =>
  jsonResponse({ error: 'BSEngine unreachable', detail }, 503);
