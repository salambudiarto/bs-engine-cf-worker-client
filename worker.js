/**
 * BSEngine HTTP API Gateway -- Cloudflare Worker
 *
 * Routes HTTP requests to a BSEngine TCP backend running via Pinggy tunnel.
 *
 * TCP Wire Formats (from main.go):
 *   Request:  Magic(2) | Op(1) | ReqID(4) | KeyLen(1) | ValLen(4) | Key | Val
 *   Response: Magic(2) | ReqID(4) | Status(1) | DataLen(4) | Data
 *
 * HTTP API Endpoints:
 *   GET    /ping                  -> OpPing   (0x05)
 *   GET    /get/:key              -> OpView   (0x02)
 *   POST   /set/:key              -> OpUpsert (0x01)
 *   DELETE /delete/:key           -> OpDelete (0x03)
 *   POST   /incr/:key             -> OpIncr   (0x04)
 *   GET    /stats                 -> OpStats  (0x06)
 *   POST   /evict                 -> OpEvict  (0x07)
 */

// REQUIRED: explicit import -- connect() is NOT a global in Cloudflare Workers
import { connect } from "cloudflare:sockets";

// =============================================================================
// CONFIGURATION
// =============================================================================

const BACKEND_HOST = "akxpa-114-8-218-205.a.free.pinggy.link";
const BACKEND_PORT = 44771;

// Must match constants in main.go exactly
const MAGIC_BYTES      = 0xBE57;
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

// Enforced by main.go -- reject early at gateway before opening TCP
const MAX_KEY_SIZE   = 64;
const MAX_VALUE_SIZE = 10 * 1024 * 1024; // 10 MB

// Timeout for entire TCP round-trip (ms). CF Worker max CPU time is 30s.
const TCP_TIMEOUT_MS = 10_000;

// =============================================================================
// REQUEST ID COUNTER
// =============================================================================

let reqCounter = 0;
function nextReqID() {
  reqCounter = (reqCounter + 1) >>> 0; // uint32 wrap-around
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, reqCounter, true); // little-endian
  return buf;
}

// =============================================================================
// BINARY FRAME BUILDER
// =============================================================================

/**
 * Build a complete BSEngine request frame as a single Uint8Array.
 *
 * Frame layout:
 *   [0:2]  Magic    uint16 LE  0xBE57
 *   [2]    Op       uint8      opcode
 *   [3:7]  ReqID    uint32 LE  monotonic counter
 *   [7]    KeyLen   uint8      1-64
 *   [8:12] ValLen   uint32 LE  0-10485760
 *   [12..] Key      []byte
 *   [..]   Val      []byte
 *
 * IMPORTANT: main.go rejects connections where keyLen == 0 OR keyLen > 64.
 * ALL opcodes (including Ping/Stats/Evict) must send a non-empty key.
 * We use "x" (1 byte) as the placeholder key for keyless operations.
 */
function buildRequest(op, key, value) {
  const keyBytes = new TextEncoder().encode(key);
  const valBytes = value instanceof Uint8Array ? value : new TextEncoder().encode(value);

  if (keyBytes.length === 0 || keyBytes.length > MAX_KEY_SIZE) {
    throw new Error(`buildRequest: key length ${keyBytes.length} out of range 1-${MAX_KEY_SIZE}`);
  }

  const header = new Uint8Array(12);
  const dv = new DataView(header.buffer);
  dv.setUint16(0, MAGIC_BYTES, true);    // [0:2]  Magic LE
  header[2] = op;                         // [2]    Op
  header.set(nextReqID(), 3);             // [3:7]  ReqID LE
  header[7] = keyBytes.length;            // [7]    KeyLen
  dv.setUint32(8, valBytes.length, true); // [8:12] ValLen LE

  const packet = new Uint8Array(12 + keyBytes.length + valBytes.length);
  packet.set(header, 0);
  packet.set(keyBytes, 12);
  packet.set(valBytes, 12 + keyBytes.length);
  return packet;
}

// =============================================================================
// TCP TRANSPORT
// =============================================================================

/**
 * Read EXACTLY n bytes from a ReadableStreamDefaultReader.
 *
 * Cloudflare TCP chunks arrive in arbitrary sizes. A carry-buffer accumulates
 * bytes across multiple reader.read() calls. Leftover bytes after satisfying
 * one readExact call are preserved in carry for the next call.
 *
 * @param {ReadableStreamDefaultReader} reader
 * @param {number} n            - exact number of bytes to return
 * @param {{ buf: Uint8Array, len: number }} carry - shared carry state
 * @returns {Promise<Uint8Array>} - exactly n bytes, newly allocated
 */
async function readExact(reader, n, carry) {
  // Ensure carry buffer is large enough to hold n bytes
  if (carry.buf.length < n) {
    const grown = new Uint8Array(Math.max(n * 2, 512));
    grown.set(carry.buf.subarray(0, carry.len));
    carry.buf = grown;
  }

  // Pull chunks from the stream until we have at least n bytes buffered
  while (carry.len < n) {
    const { value, done } = await reader.read();
    if (done) {
      throw new Error(`TCP stream closed prematurely: have ${carry.len}, need ${n}`);
    }
    // Grow carry buffer if the incoming chunk overflows remaining space
    if (carry.len + value.length > carry.buf.length) {
      const grown = new Uint8Array((carry.len + value.length) * 2);
      grown.set(carry.buf.subarray(0, carry.len));
      carry.buf = grown;
    }
    carry.buf.set(value, carry.len);
    carry.len += value.length;
  }

  // Slice out exactly n bytes into a fresh array
  const result = carry.buf.slice(0, n);

  // Shift remaining bytes to the front of the carry buffer
  if (carry.len > n) {
    carry.buf.copyWithin(0, n, carry.len);
  }
  carry.len -= n;

  return result;
}

/**
 * Open one TCP connection, send a BSEngine request, read the full response,
 * then close the connection. A hard timeout aborts stuck connections.
 *
 * Bug fixes vs original implementation:
 *  1. carry-buffer readExact -- no longer loses bytes between chunk boundaries
 *  2. writer.releaseLock() after send -- prevents flow-control stall during read
 *  3. Timeout via Promise.race -- prevents worker from hanging indefinitely
 *  4. writer.close() removed from finally -- close is handled by socket.close()
 *
 * @param {number} op       - opcode constant
 * @param {string} key      - storage key (must be 1-64 bytes after UTF-8 encode)
 * @param {Uint8Array} value - value payload (empty for read/ping/stats/evict)
 * @returns {Promise<{ status: number, data: Uint8Array }>}
 */
async function sendBSEngineRequest(op, key, value) {
  const doRequest = async () => {
    const socket = connect({ hostname: BACKEND_HOST, port: BACKEND_PORT });

    // --- SEND -----------------------------------------------------------------
    // Get writer, send the frame, then immediately release the lock.
    // Holding the writer lock while reading blocks the socket's internal
    // flow-control on Cloudflare's edge runtime.
    const writer = socket.writable.getWriter();
    try {
      await writer.write(buildRequest(op, key, value));
    } finally {
      // releaseLock() (not close()) -- we want the socket open for reading
      writer.releaseLock();
    }

    // --- RECEIVE --------------------------------------------------------------
    const reader = socket.readable.getReader();
    const carry  = { buf: new Uint8Array(512), len: 0 };

    try {
      // Response header: Magic(2) + ReqID(4) + Status(1) + DataLen(4) = 11 bytes
      const hdr    = await readExact(reader, 11, carry);
      const dv     = new DataView(hdr.buffer, hdr.byteOffset, hdr.byteLength);
      const magic  = dv.getUint16(0, true);

      if (magic !== MAGIC_BYTES) {
        throw new Error(`Protocol error: bad magic 0x${magic.toString(16)} (expected 0x${MAGIC_BYTES.toString(16)})`);
      }

      const status  = hdr[6];
      const dataLen = dv.getUint32(7, true);

      if (dataLen > MAX_VALUE_SIZE) {
        throw new Error(`Protocol error: dataLen ${dataLen} exceeds MAX_VALUE_SIZE`);
      }

      let data = new Uint8Array(0);
      if (dataLen > 0) {
        data = await readExact(reader, dataLen, carry);
      }

      return { status, data };
    } finally {
      try { reader.cancel();      } catch (_) {}
      try { await socket.close(); } catch (_) {}
    }
  };

  // Race the request against a hard timeout
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`TCP timeout after ${TCP_TIMEOUT_MS}ms`)), TCP_TIMEOUT_MS)
  );

  return Promise.race([doRequest(), timeout]);
}

// =============================================================================
// ROUTE HANDLERS
// =============================================================================

/**
 * GET /ping
 * Uses key "p" (1 byte) -- minimal valid key for a keyless opcode.
 */
async function handlePing() {
  const t0 = Date.now();
  const { status } = await sendBSEngineRequest(OP_PING, "p", new Uint8Array(0));
  if (status !== STATUS_OK) {
    return jsonResponse({ error: "ping failed", status_code: status }, 502);
  }
  return jsonResponse({ ok: true, latency_ms: Date.now() - t0 });
}

/**
 * GET /get/:key
 * Returns value as UTF-8 string (JSON parsed if valid), or base64 for binary.
 */
async function handleGet(key) {
  if (!validateKey(key)) return keyError();

  const { status, data } = await sendBSEngineRequest(OP_VIEW, key, new Uint8Array(0));
  if (status === STATUS_NOT_FOUND) return jsonResponse({ error: "key not found" }, 404);
  if (status === STATUS_ERROR)     return jsonResponse({ error: "engine error" }, 500);

  let value;
  try {
    const str = new TextDecoder("utf-8", { fatal: true }).decode(data);
    try { value = JSON.parse(str); } catch (_) { value = str; }
  } catch (_) {
    // Not valid UTF-8 -- return as base64
    value = btoa(String.fromCharCode(...data));
  }
  return jsonResponse({ key, value });
}

/**
 * GET /counter/:key
 * Reads a key stored by /incr and decodes it as int64 little-endian.
 * Use this instead of /get/:key for any key written via POST /incr.
 */
async function handleCounter(key) {
  if (!validateKey(key)) return keyError();

  const { status, data } = await sendBSEngineRequest(OP_VIEW, key, new Uint8Array(0));
  if (status === STATUS_NOT_FOUND) return jsonResponse({ error: "key not found" }, 404);
  if (status === STATUS_ERROR)     return jsonResponse({ error: "engine error" }, 500);

  if (data.length !== 8) {
    return jsonResponse({
      error: `expected 8-byte int64, got ${data.length} bytes — key was not written by /incr`,
    }, 422);
  }

  const value = Number(new DataView(data.buffer, data.byteOffset).getBigInt64(0, true));
  return jsonResponse({ key, value });
}

/**
 * POST /set/:key
 * Content-Type determines how the body is stored:
 *   text/plain (default) -- raw UTF-8 string
 *   application/json     -- raw JSON string (stored verbatim, not parsed)
 *   application/octet-stream -- binary blob
 */
async function handleSet(key, request) {
  if (!validateKey(key)) return keyError();

  const ct = request.headers.get("content-type") || "";
  let valueBytes;

  if (ct.includes("application/octet-stream")) {
    valueBytes = new Uint8Array(await request.arrayBuffer());
  } else {
    valueBytes = new TextEncoder().encode(await request.text());
  }

  if (valueBytes.length > MAX_VALUE_SIZE) {
    return jsonResponse({ error: `value exceeds max size (${MAX_VALUE_SIZE} bytes)` }, 413);
  }

  const { status } = await sendBSEngineRequest(OP_UPSERT, key, valueBytes);
  if (status === STATUS_ERROR) return jsonResponse({ error: "upsert failed" }, 500);
  return jsonResponse({ ok: true, key });
}

/**
 * DELETE /delete/:key
 */
async function handleDelete(key) {
  if (!validateKey(key)) return keyError();

  const { status } = await sendBSEngineRequest(OP_DELETE, key, new Uint8Array(0));
  if (status === STATUS_NOT_FOUND) return jsonResponse({ error: "key not found" }, 404);
  if (status === STATUS_ERROR)     return jsonResponse({ error: "delete failed" }, 500);
  return jsonResponse({ ok: true, key });
}

/**
 * POST /incr/:key
 * Body (optional JSON): { "delta": <integer> }   default delta = 1
 *
 * Engine stores counter as int64 (8 bytes LE). Key must not previously
 * hold a non-numeric value -- delete it first if so.
 */
async function handleIncr(key, request) {
  if (!validateKey(key)) return keyError();

  let delta = 1n;
  try {
    const body = await request.json();
    if (body.delta !== undefined) delta = BigInt(body.delta);
  } catch (_) {
    // Empty or non-JSON body -- use default delta = 1
  }

  // Encode delta as int64 little-endian (8 bytes) -- matches main.go OpIncr
  const valBuf = new Uint8Array(8);
  new DataView(valBuf.buffer).setBigInt64(0, delta, true);

  const { status, data } = await sendBSEngineRequest(OP_INCR, key, valBuf);
  if (status === STATUS_ERROR) {
    return jsonResponse({ error: "incr failed -- key may hold a non-numeric value; DELETE it first" }, 500);
  }

  let newValue = null;
  if (data.length === 8) {
    newValue = Number(new DataView(data.buffer, data.byteOffset).getBigInt64(0, true));
  }
  return jsonResponse({ ok: true, key, new_value: newValue, delta: Number(delta) });
}

/**
 * GET /stats
 *
 * OpStats response layout (main.go):
 *   keys(8 uint64 LE) + ops(8) + pages(8) + cachedPages(4 uint32 LE) + idleSecs(8) = 36 bytes
 *
 * Uses key "s" (1 byte) as the mandatory placeholder key.
 */
async function handleStats() {
  const { status, data } = await sendBSEngineRequest(OP_STATS, "s", new Uint8Array(0));

  if (status !== STATUS_OK) {
    return jsonResponse({ error: "stats failed", status_code: status }, 500);
  }
  if (data.length < 36) {
    return jsonResponse({ error: `incomplete stats: got ${data.length} bytes, need 36` }, 502);
  }

  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return jsonResponse({
    keys:         Number(dv.getBigUint64(0,  true)),
    total_ops:    Number(dv.getBigUint64(8,  true)),
    total_pages:  Number(dv.getBigUint64(16, true)),
    cached_pages: dv.getUint32(24, true),
    idle_secs:    Number(dv.getBigUint64(28, true)),
  });
}

/**
 * POST /evict
 * Triggers shrinkPool + shrinkIndex + GC on the backend asynchronously.
 * Uses key "e" (1 byte) as the mandatory placeholder key.
 */
async function handleEvict() {
  const { status } = await sendBSEngineRequest(OP_EVICT, "e", new Uint8Array(0));
  if (status === STATUS_ERROR) return jsonResponse({ error: "evict trigger failed" }, 500);
  return jsonResponse({ ok: true, message: "cache eviction triggered in background" });
}

// =============================================================================
// HELPERS
// =============================================================================

function validateKey(key) {
  if (!key || key.length === 0) return false;
  const encoded = new TextEncoder().encode(key);
  return encoded.length >= 1 && encoded.length <= MAX_KEY_SIZE;
}

function keyError() {
  return jsonResponse({ error: `key must be 1-${MAX_KEY_SIZE} bytes (UTF-8 encoded)` }, 400);
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
    },
  });
}

// =============================================================================
// MAIN FETCH HANDLER
// =============================================================================

export default {
  async fetch(request, env, ctx) {
    const url      = new URL(request.url);
    const method   = request.method.toUpperCase();
    const segments = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
    const route    = segments[0] || "";
    const key      = segments[1] ? decodeURIComponent(segments[1]) : "";

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
      if (route === "ping"   && method === "GET")    return await handlePing();
      if (route === "stats"  && method === "GET")    return await handleStats();
      if (route === "evict"  && method === "POST")   return await handleEvict();
      if (route === "get"    && method === "GET")    return await handleGet(key);
      if (route === "counter" && method === "GET") return await handleCounter(key);
      if (route === "set"    && method === "POST")   return await handleSet(key, request);
      if (route === "delete" && method === "DELETE") return await handleDelete(key);
      if (route === "incr"   && method === "POST")   return await handleIncr(key, request);

      if (route === "") {
        return jsonResponse({
          engine:  "BSEngine HTTP Gateway",
          version: "2.0.0",
          backend: `${BACKEND_HOST}:${BACKEND_PORT}`,
          routes: {
            "GET    /ping":          "latency probe",
            "GET    /stats":         "engine metrics (keys, ops, pages, cache, idle)",
            "POST   /evict":         "trigger manual cache eviction + GC",
            "GET    /get/:key":      "read value by key",
            "GET    /counter/:key":  "read int64 counter set by /incr",
            "POST   /set/:key":      "write value (body: text/json/binary)",
            "DELETE /delete/:key":   "delete key",
            "POST   /incr/:key":     'atomic increment (body: {"delta": N}, default 1)',
          },
        });
      }

      return jsonResponse({ error: "route not found", path: url.pathname }, 404);

    } catch (err) {
      const msg = err?.message ?? String(err);
      const isNetErr = /connect|tcp|stream|timeout|closed/i.test(msg);
      return jsonResponse(
        {
          error:   isNetErr ? "backend unreachable" : "internal gateway error",
          detail:  msg,
          backend: `${BACKEND_HOST}:${BACKEND_PORT}`,
        },
        isNetErr ? 503 : 500,
      );
    }
  },
};