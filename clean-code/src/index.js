/**
 * BSEngine Cloudflare Worker — Main Entry Point & Router
 *
 * This Worker acts as a lightweight HTTP gateway to a BSEngine TCP server.
 * All heavy lifting (WAL, buffer pool, defrag) remains on the BSEngine side;
 * the Worker is responsible only for HTTP↔binary-protocol translation.
 *
 * Route table:
 *   GET    /ping              → OpPing   — round-trip health check
 *   GET    /stats             → OpStats  — engine metrics (keys/ops/pages)
 *   GET    /keys/:key         → OpView   — retrieve a stored value
 *   PUT    /keys/:key         → OpUpsert — create or overwrite a value
 *   DELETE /keys/:key         → OpDelete — remove a key
 *   POST   /keys/:key/incr    → OpIncr   — atomic int64 counter increment
 */

import { handlePing }   from './handlers/ping.js';
import { handleStats }  from './handlers/stats.js';
import { handleView }   from './handlers/view.js';
import { handleUpsert } from './handlers/upsert.js';
import { handleDelete } from './handlers/delete.js';
import { handleIncr }   from './handlers/incr.js';
import { jsonResponse } from './utils/http.js';

export default {
  /**
   * @param {Request}     request
   * @param {unknown}     _env   — Cloudflare environment bindings (unused)
   * @param {unknown}     _ctx   — execution context (unused)
   * @returns {Promise<Response>}
   */
  async fetch(request, _env, _ctx) {
    const url    = new URL(request.url);
    const method = request.method.toUpperCase();
    const path   = url.pathname;

    // ── Static routes ──────────────────────────────────────────────────────
    if (path === '/ping'  && method === 'GET') return handlePing();
    if (path === '/stats' && method === 'GET') return handleStats();

    // ── /keys/:key[/incr] routes ───────────────────────────────────────────
    // Pattern: /keys/<key>  or  /keys/<key>/incr
    // Keys must NOT contain '/' — they map directly to BSEngine key bytes.
    const keysRoot = '/keys/';
    if (path.startsWith(keysRoot)) {
      const rawSegment = decodeURIComponent(path.slice(keysRoot.length));

      // POST /keys/:key/incr
      if (rawSegment.endsWith('/incr') && method === 'POST') {
        const key = rawSegment.slice(0, -'/incr'.length);
        return handleIncr(key, request);
      }

      // Reject keys with path separators to prevent ambiguous routing
      if (rawSegment.includes('/')) {
        return jsonResponse({ error: 'Keys must not contain "/"' }, 400);
      }

      switch (method) {
        case 'GET':    return handleView(rawSegment);
        case 'PUT':    return handleUpsert(rawSegment, request);
        case 'DELETE': return handleDelete(rawSegment);
        default:       return jsonResponse({ error: 'Method Not Allowed' }, 405);
      }
    }

    // ── 404 fallback ───────────────────────────────────────────────────────
    return jsonResponse({
      error : 'Not Found',
      routes: [
        'GET  /ping',
        'GET  /stats',
        'GET  /keys/:key',
        'PUT  /keys/:key',
        'DELETE /keys/:key',
        'POST /keys/:key/incr',
      ],
    }, 404);
  },
};
