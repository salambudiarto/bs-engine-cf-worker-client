/**
 * BSEngine HTTP API Gateway — Cloudflare Worker
 *
 * Routes HTTP requests to a BSEngine TCP backend running via Pinggy tunnel.
 *
 * TCP Wire Formats (from main.go):
 *   Request:  Magic(2) | Op(1) | ReqID(4) | KeyLen(1) | ValLen(4) | Key | Val
 *   Response: Magic(2) | ReqID(4) | Status(1) | DataLen(4) | Data
 *
 * HTTP API Endpoints:
 *   GET    /ping                    → OpPing   (0x05) — latency probe
 *   GET    /get/:key                → OpView   (0x02) — read value
 *   POST   /set/:key                → OpUpsert (0x01) — write value (body = raw bytes or JSON)
 *   DELETE /delete/:key             → OpDelete (0x03) — delete key
 *   POST   /incr/:key               → OpIncr   (0x04) — atomic increment (body: {"delta": N})
 *   GET    /stats                   → OpStats  (0x06) — engine metrics
 *   POST   /evict                   → OpEvict  (0x07) — manual cache eviction trigger
 */

// ─── Configuration ───────────────────────────────────────────────────────────

const BACKEND_HOST = "zgyie-114-8-218-205.a.free.pinggy.link";
const BACKEND_PORT = 32779;

// BSEngine binary protocol constants
const MAGIC_BYTES  = 0xBE57;   // uint16 LE — must match MagicBytes in main.go
const STATUS_OK        = 0x00;
const STATUS_NOT_FOUND = 0x01;
const STATUS_ERROR     = 0x02;

const OP_UPSERT = 0x01;
const OP_VIEW   = 0x02;
const OP_DELETE = 0x03;
const OP_INCR   = 0x04;
const OP_PING   = 0x05;
const OP_STATS  = 0x06;
const OP_EVICT  = 0x07;

// Max sizes enforced by main.go — reject early at the gateway layer
const MAX_KEY_SIZE   = 64;
const MAX_VALUE_SIZE = 10 * 1024 * 1024; // 10 MB

// ─── Request ID counter (per-isolate, wraps at 2^32) ─────────────────────────
let reqCounter = 0;
function nextReqID() {
  reqCounter = (reqCounter + 1) >>> 0; // uint32 wrap
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, reqCounter, true); // little-endian
  return buf;
}

// ─── Binary helpers ──────────────────────────────────────────────────────────

/** Build the 12-byte request header + key + value payload. */
function buildRequest(op, key, value = new Uint8Array(0)) {
  const keyBytes  = new TextEncoder().encode(key);
  const valBytes  = value instanceof Uint8Array ? value : new TextEncoder().encode(value);
  const reqID     = nextReqID();

  // Header: Magic(2 LE) + Op(1) + ReqID(4 LE) + KeyLen(1) + ValLen(4 LE)
  const header = new Uint8Array(12);
  const dv     = new DataView(header.buffer);
  dv.setUint16(0, MAGIC_BYTES, true);   // [0:2]  Magic LE
  header[2] = op;                        // [2]    Op
  header.set(reqID, 3);                  // [3:7]  ReqID LE
  header[7] = keyBytes.length;           // [7]    KeyLen (1 byte, max 64)
  dv.setUint32(8, valBytes.length, true);// [8:12] ValLen LE

  const packet = new Uint8Array(12 + keyBytes.length + valBytes.length);
  packet.set(header, 0);
  packet.set(keyBytes, 12);
  packet.set(valBytes, 12 + keyBytes.length);
  return packet;
}

/**
 * Read exactly `n` bytes from the TCP socket reader.
 * Cloudflare's TCP socket reader returns chunks; we reassemble them.
 */
async function readExact(reader, n) {
  const chunks = [];
  let received = 0;
  while (received < n) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`TCP stream ended after ${received}/${n} bytes`);
    chunks.push(value);
    received += value.length;
  }
  // Merge and return exactly n bytes
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) { merged.set(c, offset); offset += c.length; }
  return merged.slice(0, n);
}

/**
 * Send one BSEngine request and receive the full response over TCP.
 * Opens a fresh TCP connection per request (stateless gateway pattern).
 */
async function sendBSEngineRequest(op, key, value) {
  // Cloudflare Workers TCP sockets API (connect())
  const socket = connect({ hostname: BACKEND_HOST, port: BACKEND_PORT });
  const writer  = socket.writable.getWriter();
  const reader  = socket.readable.getReader();

  try {
    // ── Send request ──────────────────────────────────────────────────────
    const packet = buildRequest(op, key, value);
    await writer.write(packet);

    // ── Read response header: Magic(2) + ReqID(4) + Status(1) + DataLen(4) = 11 bytes
    const respHeader = await readExact(reader, 11);
    const dv         = new DataView(respHeader.buffer);
    const magic      = dv.getUint16(0, true);

    if (magic !== MAGIC_BYTES) {
      throw new Error(`Protocol error: unexpected magic 0x${magic.toString(16)}`);
    }

    const status  = respHeader[6];
    const dataLen = dv.getUint32(7, true);

    // ── Read response data (if any) ───────────────────────────────────────
    let data = new Uint8Array(0);
    if (dataLen > 0) {
      data = await readExact(reader, dataLen);
    }

    return { status, data };
  } finally {
    try { reader.cancel();  } catch (_) {}
    try { writer.close();   } catch (_) {}
    try { await socket.close(); } catch (_) {}
  }
}

// ─── Route handlers ──────────────────────────────────────────────────────────

/** GET /ping */
async function handlePing() {
  const t0 = Date.now();
  const { status } = await sendBSEngineRequest(OP_PING, "_ping_", new Uint8Array(0));
  if (status !== STATUS_OK) {
    return jsonResponse({ error: "ping failed", status }, 502);
  }
  return jsonResponse({ ok: true, latency_ms: Date.now() - t0 });
}

/** GET /get/:key */
async function handleGet(key) {
  if (!validateKey(key)) return keyError();
  const { status, data } = await sendBSEngineRequest(OP_VIEW, key, new Uint8Array(0));
  if (status === STATUS_NOT_FOUND) return jsonResponse({ error: "key not found" }, 404);
  if (status === STATUS_ERROR)     return jsonResponse({ error: "engine error" }, 500);

  // Try to decode as UTF-8 string; fall back to base64 for binary values
  let value;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(data);
    // If it looks like JSON, parse it for a cleaner response
    try { value = JSON.parse(value); } catch (_) {}
  } catch (_) {
    value = btoa(String.fromCharCode(...data)); // base64 for binary
  }
  return jsonResponse({ key, value });
}

/** POST /set/:key  — body: raw text, JSON, or binary */
async function handleSet(key, request) {
  if (!validateKey(key)) return keyError();

  const contentType = request.headers.get("content-type") || "";
  let valueBytes;

  if (contentType.includes("application/octet-stream")) {
    valueBytes = new Uint8Array(await request.arrayBuffer());
  } else if (contentType.includes("application/json")) {
    const text = await request.text();
    valueBytes = new TextEncoder().encode(text); // store raw JSON string
  } else {
    // Default: treat body as plain text / any string
    const text = await request.text();
    valueBytes = new TextEncoder().encode(text);
  }

  if (valueBytes.length > MAX_VALUE_SIZE) {
    return jsonResponse({ error: `value exceeds max size (${MAX_VALUE_SIZE} bytes)` }, 413);
  }

  const { status } = await sendBSEngineRequest(OP_UPSERT, key, valueBytes);
  if (status === STATUS_ERROR) return jsonResponse({ error: "upsert failed" }, 500);
  return jsonResponse({ ok: true, key });
}

/** DELETE /delete/:key */
async function handleDelete(key) {
  if (!validateKey(key)) return keyError();
  const { status } = await sendBSEngineRequest(OP_DELETE, key, new Uint8Array(0));
  if (status === STATUS_NOT_FOUND) return jsonResponse({ error: "key not found" }, 404);
  if (status === STATUS_ERROR)     return jsonResponse({ error: "delete failed" }, 500);
  return jsonResponse({ ok: true, key });
}

/**
 * POST /incr/:key
 * Body: { "delta": <integer> }   (default delta = 1)
 * The engine stores the counter as an int64 (8 bytes LE).
 */
async function handleIncr(key, request) {
  if (!validateKey(key)) return keyError();

  let delta = 1n; // BigInt for int64
  try {
    const body = await request.json();
    if (body.delta !== undefined) delta = BigInt(body.delta);
  } catch (_) {
    // No body or parse error → use default delta = 1
  }

  // Encode delta as int64 little-endian (8 bytes) — matches main.go OpIncr handler
  const valBuf = new Uint8Array(8);
  new DataView(valBuf.buffer).setBigInt64(0, delta, true);

  const { status, data } = await sendBSEngineRequest(OP_INCR, key, valBuf);
  if (status === STATUS_ERROR) return jsonResponse({ error: "incr failed (key may not be numeric)" }, 500);

  let newValue = null;
  if (data.length === 8) {
    newValue = Number(new DataView(data.buffer).getBigInt64(0, true));
  }
  return jsonResponse({ ok: true, key, new_value: newValue, delta: Number(delta) });
}

/**
 * GET /stats
 * Response layout from main.go OpStats:
 *   keys(8) + ops(8) + pages(8) + cachedPages(4) + idleSecs(8) = 36 bytes
 */
async function handleStats() {
  const { status, data } = await sendBSEngineRequest(OP_STATS, "_stats_", new Uint8Array(0));
  if (status !== STATUS_OK) return jsonResponse({ error: "stats failed" }, 500);
  if (data.length < 36)     return jsonResponse({ error: "incomplete stats response" }, 502);

  const dv = new DataView(data.buffer);
  return jsonResponse({
    keys:         Number(dv.getBigUint64(0,  true)),
    total_ops:    Number(dv.getBigUint64(8,  true)),
    total_pages:  Number(dv.getBigUint64(16, true)),
    cached_pages: dv.getUint32(24, true),
    idle_secs:    Number(dv.getBigUint64(28, true)),
  });
}

/** POST /evict — triggers manual cache shrink + GC on the engine */
async function handleEvict() {
  // OpEvict: engine responds immediately; eviction runs in background on the Go side
  const { status } = await sendBSEngineRequest(OP_EVICT, "_evict_", new Uint8Array(0));
  if (status === STATUS_ERROR) return jsonResponse({ error: "evict failed" }, 500);
  return jsonResponse({ ok: true, message: "eviction triggered in background" });
}

// ─── Validation helpers ──────────────────────────────────────────────────────

function validateKey(key) {
  return key && key.length > 0 && key.length <= MAX_KEY_SIZE;
}

function keyError() {
  return jsonResponse({ error: `key must be 1–${MAX_KEY_SIZE} characters` }, 400);
}

// ─── Response helper ─────────────────────────────────────────────────────────

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*", // CORS — adjust as needed
    },
  });
}

// ─── Main fetch handler ──────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url      = new URL(request.url);
    const method   = request.method.toUpperCase();
    const segments = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
    // segments[0] = route prefix, segments[1] = key (if present)

    // CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin":  "*",
          "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
          "access-control-allow-headers": "content-type",
        },
      });
    }

    try {
      const route = segments[0];
      const key   = segments[1] ? decodeURIComponent(segments[1]) : "";

      // ── Route dispatch ──────────────────────────────────────────────────
      if (route === "ping"   && method === "GET")    return await handlePing();
      if (route === "stats"  && method === "GET")    return await handleStats();
      if (route === "evict"  && method === "POST")   return await handleEvict();
      if (route === "get"    && method === "GET")    return await handleGet(key);
      if (route === "set"    && method === "POST")   return await handleSet(key, request);
      if (route === "delete" && method === "DELETE") return await handleDelete(key);
      if (route === "incr"   && method === "POST")   return await handleIncr(key, request);

      // ── Root — show available routes ────────────────────────────────────
      if (!route || route === "") {
        return jsonResponse({
          engine:  "BSEngine HTTP Gateway",
          backend: `${BACKEND_HOST}:${BACKEND_PORT}`,
          routes: {
            "GET  /ping":          "latency probe",
            "GET  /stats":         "engine metrics (keys, ops, pages, cache, idle)",
            "POST /evict":         "trigger manual cache eviction + GC",
            "GET  /get/:key":      "read value by key",
            "POST /set/:key":      "write value (body = text/json/binary)",
            "DELETE /delete/:key": "delete key",
            "POST /incr/:key":     "atomic increment (body: {\"delta\": N}, default 1)",
          },
        });
      }

      return jsonResponse({ error: "not found", path: url.pathname }, 404);

    } catch (err) {
      // Surface backend connection errors clearly
      const isConnErr = err.message?.toLowerCase().includes("tcp") ||
                        err.message?.toLowerCase().includes("connect") ||
                        err.message?.toLowerCase().includes("stream");
      return jsonResponse(
        {
          error:   isConnErr ? "backend unreachable" : "internal error",
          detail:  err.message,
          backend: `${BACKEND_HOST}:${BACKEND_PORT}`,
        },
        isConnErr ? 503 : 500,
      );
    }
  },
};