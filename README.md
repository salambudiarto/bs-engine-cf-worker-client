<div align="center">

# ⚡ BSEngine HTTP Gateway

**Cloudflare Worker · HTTP-to-TCP API Gateway for [BSEngine](https://github.com/)**

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Runtime](https://img.shields.io/badge/Runtime-V8_Isolate-4A90D9?style=flat-square&logo=v8&logoColor=white)](https://developers.cloudflare.com/workers/runtime-apis/)
[![Protocol](https://img.shields.io/badge/Protocol-Binary_TCP-00C897?style=flat-square&logo=protobuf&logoColor=white)](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)
[![Tunnel](https://img.shields.io/badge/Tunnel-Pinggy.io-7C3AED?style=flat-square)](https://pinggy.io/)
[![License](https://img.shields.io/badge/License-MIT-22C55E?style=flat-square)](LICENSE)
[![Status](https://img.shields.io/badge/Status-Production--Ready-22C55E?style=flat-square)]()

<br/>

> Translates standard **HTTP/JSON** requests into **BSEngine's custom binary TCP protocol** — giving any HTTP client zero-friction access to a high-performance embedded key-value store.

<br/>

```
HTTP Client  ──►  Cloudflare Worker (Edge)  ──►  Pinggy TCP Tunnel  ──►  BSEngine (Go)
     JSON              Binary framing               TLS TCP                  KV Store
```

</div>

---

## 📋 Table of Contents

- [Overview](#-overview)
- [Architecture](#-architecture)
- [Binary Protocol](#-binary-protocol)
- [API Reference](#-api-reference)
- [Quick Start](#-quick-start)
- [Configuration](#-configuration)
- [Usage Examples](#-usage-examples)
- [Error Handling](#-error-handling)
- [Observability](#-observability)
- [Deployment](#-deployment)
- [Troubleshooting](#-troubleshooting)
- [Security Considerations](#-security-considerations)
- [Contributing](#-contributing)

---

## 🔍 Overview

`worker.js` is a **Cloudflare Worker** that acts as a **protocol translation gateway** between standard HTTP clients and a [BSEngine](https://github.com/) TCP server tunnelled through [Pinggy.io](https://pinggy.io/).

**Why this exists:**

BSEngine speaks a compact custom **binary TCP protocol** — efficient for embedded Go services but inaccessible to most HTTP clients, browsers, serverless functions, and third-party integrations. This Worker bridges that gap, exposing a clean, RESTful JSON API at the network edge with **sub-millisecond** protocol translation overhead.

**Key characteristics:**

| Property | Detail |
|---|---|
| **Deployment** | Cloudflare Workers (V8 Isolate, ~0ms cold start) |
| **Transport** | `cloudflare:sockets` TCP — persistent per-request connection |
| **Framing** | BSEngine binary protocol (`Magic 0xBE57`, LE-encoded, CRC-verified) |
| **Latency** | Edge-to-backend only; no regional routing overhead |
| **Concurrency** | Per-isolate `reqCounter` (uint32, wraps at 2³²) |
| **Max key size** | 64 bytes (enforced at gateway before TCP round-trip) |
| **Max value size** | 10 MB (enforced at gateway before TCP round-trip) |

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        CLOUDFLARE EDGE NETWORK                          │
│                                                                         │
│   ┌──────────┐   HTTP/HTTPS   ┌────────────────────────────────────┐   │
│   │  Client  │ ─────────────► │         worker.js                  │   │
│   │ (any)    │ ◄───────────── │                                    │   │
│   └──────────┘   JSON resp    │  ① URL routing & validation        │   │
│                               │  ② Binary packet construction      │   │
│                               │  ③ TCP connect (cloudflare:sockets)│   │
│                               │  ④ Write request frame             │   │
│                               │  ⑤ Read & decode response frame    │   │
│                               │  ⑥ Marshal JSON response           │   │
│                               └───────────────┬────────────────────┘   │
└───────────────────────────────────────────────┼────────────────────────┘
                                                │ TCP  :32779
                                    ┌───────────▼────────────┐
                                    │   Pinggy.io TCP Tunnel  │
                                    │  (free.pinggy.link)     │
                                    └───────────┬─────────────┘
                                                │ TCP  :7070
                                    ┌───────────▼────────────┐
                                    │    BSEngine (Go)        │
                                    │                         │
                                    │  ┌─────────────────┐   │
                                    │  │  WAL  │  LRU     │   │
                                    │  │  Log  │  Pool    │   │
                                    │  ├───────┴──────────┤   │
                                    │  │   Slotted Pages  │   │
                                    │  │   (4 KiB each)   │   │
                                    │  └─────────────────┘   │
                                    └────────────────────────┘
```

### Request Lifecycle

```
1. HTTP Request  →  URL parsed, method validated, key extracted + decoded
2. Validation   →  Key ≤ 64 B, Value ≤ 10 MB, checked before TCP open
3. TCP Open     →  cloudflare:sockets connect() to Pinggy endpoint
4. Frame Write  →  Magic(2) | Op(1) | ReqID(4) | KeyLen(1) | ValLen(4) | Key | Val
5. Frame Read   →  Magic(2) | ReqID(4) | Status(1) | DataLen(4) | Data
6. Decode       →  Status → HTTP status; Data → JSON (UTF-8 or base64 fallback)
7. TCP Close    →  writer.close() + reader.cancel() + socket.close()
8. HTTP Response→  JSON payload with CORS headers
```

---

## 🔌 Binary Protocol

BSEngine uses a **compact binary protocol** over raw TCP. The Worker implements this exactly.

### Request Frame

```
Offset  Size  Type      Field       Description
──────  ────  ────────  ──────────  ────────────────────────────────────────
0       2     uint16LE  Magic       Always 0xBE57 — protocol identifier
2       1     uint8     Op          Opcode (see table below)
3       4     uint32LE  ReqID       Per-isolate monotonic counter (wraps 2³²)
7       1     uint8     KeyLen      Key length in bytes (1–64)
8       4     uint32LE  ValLen      Value length in bytes (0–10485760)
12      n     []byte    Key         UTF-8 key string
12+n    m     []byte    Val         Raw value bytes (op-dependent encoding)
```

### Response Frame

```
Offset  Size  Type      Field       Description
──────  ────  ────────  ──────────  ────────────────────────────────────────
0       2     uint16LE  Magic       Always 0xBE57 — echo back from server
2       4     []byte    ReqID       Echoed ReqID from request
6       1     uint8     Status      0x00 OK | 0x01 NotFound | 0x02 Error
7       4     uint32LE  DataLen     Length of data payload
11      n     []byte    Data        Response bytes (op-specific encoding)
```

### Opcodes

| Hex    | Name      | Constant   | Key required | Value encoding       |
|--------|-----------|------------|:---:|----------------------|
| `0x01` | Upsert    | `OP_UPSERT`| ✅  | Raw bytes            |
| `0x02` | View      | `OP_VIEW`  | ✅  | — (empty)            |
| `0x03` | Delete    | `OP_DELETE`| ✅  | — (empty)            |
| `0x04` | Increment | `OP_INCR`  | ✅  | `int64` LE (8 bytes) |
| `0x05` | Ping      | `OP_PING`  | —   | — (placeholder key)  |
| `0x06` | Stats     | `OP_STATS` | —   | — (placeholder key)  |
| `0x07` | Evict     | `OP_EVICT` | —   | — (placeholder key)  |

### Status Codes

| Hex    | Constant          | HTTP Equivalent | Meaning               |
|--------|-------------------|-----------------|-----------------------|
| `0x00` | `STATUS_OK`       | `200`           | Operation succeeded   |
| `0x01` | `STATUS_NOT_FOUND`| `404`           | Key does not exist    |
| `0x02` | `STATUS_ERROR`    | `500`           | Engine-level error    |

---

## 📡 API Reference

**Base URL:** `https://tcp-dt-engine.app140226c.workers.dev`

All responses are `application/json`. All requests support `Access-Control-Allow-Origin: *`.

---

### `GET /ping`

Latency probe — measures round-trip time to BSEngine backend.

**Response `200`**
```json
{
  "ok": true,
  "latency_ms": 42
}
```

---

### `GET /get/:key`

Read the value stored at `:key`.

**Path Parameters**

| Parameter | Type   | Constraints        | Description  |
|-----------|--------|--------------------|--------------|
| `key`     | string | 1–64 chars, URL-encoded | Storage key |

**Response `200`** — value decoded as UTF-8 string (or parsed JSON if valid):
```json
{
  "key": "user:1001",
  "value": "Alice"
}
```

**Response `200`** — binary value (base64-encoded fallback):
```json
{
  "key": "blob:img",
  "value": "iVBORw0KGgo..."
}
```

**Response `404`**
```json
{ "error": "key not found" }
```

> **Note:** Keys written via `POST /incr/:key` are stored as raw 8-byte little-endian int64. Reading them with `/get/:key` will decode the bytes as UTF-8, producing garbage output. Use `GET /counter/:key` instead for counter values.

---

### `GET /counter/:key`

Read an int64 counter value stored at `:key` (typically created via `POST /incr/:key`).

**Path Parameters**

| Parameter | Type   | Constraints        | Description  |
|-----------|--------|--------------------|--------------|
| `key`     | string | 1–64 chars, URL-encoded | Counter key |

**Response `200`**
```json
{
  "key": "page:views",
  "value": 42
}
```

**Response `404`**
```json
{ "error": "key not found" }
```

**Response `422`**
```json
{
  "error": "not a counter",
  "detail": "value is N bytes (expected exactly 8)"
}
```

> **Why this endpoint exists:** Counter keys created via `POST /incr/:key` are stored as 8-byte little-endian int64 (matching `main.go` encoding). Using `GET /get/:key` on these keys returns garbage UTF-8 text like `"\u0015\u0000..."` instead of the numeric value. This dedicated endpoint decodes the raw bytes correctly as int64.

---

### `POST /set/:key`

Write (upsert) a value at `:key`. Creates the key if absent; overwrites if present.

**Path Parameters**

| Parameter | Type   | Constraints        | Description  |
|-----------|--------|--------------------|--------------|
| `key`     | string | 1–64 chars, URL-encoded | Storage key |

**Request Body**

| Content-Type                  | Encoding | Use case               |
|-------------------------------|----------|------------------------|
| `text/plain` (default)        | UTF-8    | Plain text or strings  |
| `application/json`            | UTF-8    | JSON (stored verbatim) |
| `application/octet-stream`    | Binary   | Images, files, blobs   |

**Response `200`**
```json
{ "ok": true, "key": "user:1001" }
```

**Response `413`** — value exceeds 10 MB

---

### `DELETE /delete/:key`

Delete the key-value pair at `:key`.

**Path Parameters**

| Parameter | Type   | Constraints        | Description  |
|-----------|--------|--------------------|--------------|
| `key`     | string | 1–64 chars, URL-encoded | Storage key |

**Response `200`**
```json
{ "ok": true, "key": "user:1001" }
```

**Response `404`**
```json
{ "error": "key not found" }
```

---

### `POST /incr/:key`

Atomically increment the counter at `:key` by a signed delta. If the key does not exist, it is initialized to 0 before incrementing.

**Path Parameters**

| Parameter | Type   | Constraints        | Description  |
|-----------|--------|--------------------|--------------|
| `key`     | string | 1–64 chars, URL-encoded | Counter key |

**Request Body (optional)**

```json
{ "delta": -5 }
```

If `delta` is omitted, defaults to `1`.

**Response `200`**
```json
{
  "ok": true,
  "key": "page:views",
  "new_value": 43,
  "delta": 1
}
```

**Response `500`** — key holds a non-numeric value (delete it first):
```json
{
  "error": "incr failed -- key may hold a non-numeric value; DELETE it first"
}
```

> **Important:** Counters are stored as 8-byte little-endian int64. Use `GET /counter/:key` to read them correctly, not `GET /get/:key`.

---

### `GET /stats`

Retrieve engine-level statistics.

**Response `200`**
```json
{
  "keys": 18423,
  "total_ops": 4291032,
  "total_pages": 512,
  "cached_pages": 348,
  "idle_secs": 0
}
```

| Field          | Type   | Description                              |
|----------------|--------|------------------------------------------|
| `keys`         | uint64 | Total number of keys in the store        |
| `total_ops`    | uint64 | Cumulative operation count               |
| `total_pages`  | uint64 | Total pages allocated (4 KiB each)       |
| `cached_pages` | uint32 | Pages currently held in LRU pool         |
| `idle_secs`    | uint64 | Seconds since last operation (0 = active)|

---

### `POST /evict`

Manually trigger cache eviction and garbage collection on the backend.

**Response `200`**
```json
{
  "ok": true,
  "message": "cache eviction triggered in background"
}
```

**Response `500`** — eviction trigger failed

---

## 🚀 Quick Start

### Prerequisites

- **Cloudflare account** (free tier works)
- **Node.js** 18+ (for Wrangler CLI)
- **BSEngine** running locally or remotely
- **Pinggy tunnel** forwarding TCP to BSEngine

### 1. Install Wrangler

```bash
npm install -g wrangler
wrangler login
```

### 2. Clone & configure

```bash
git clone https://github.com/yourusername/bsengine-gateway.git
cd bsengine-gateway
```

Edit `worker.js` — update these constants:

```js
const BACKEND_HOST = "your-tunnel.a.free.pinggy.link";
const BACKEND_PORT = 32779;
```

### 3. Deploy

```bash
npx wrangler deploy
```

You'll receive a `*.workers.dev` URL. Test it:

```bash
BASE="https://your-worker.workers.dev"
curl "$BASE/ping"
```

---

## ⚙️ Configuration

All configuration is currently hardcoded as constants in `worker.js`. Refactor to environment variables if needed:

| Constant        | Default                                     | Purpose                     |
|-----------------|---------------------------------------------|-----------------------------|
| `BACKEND_HOST`  | `akxpa-114-8-218-205.a.free.pinggy.link`    | Pinggy tunnel hostname      |
| `BACKEND_PORT`  | `44771`                                     | Pinggy tunnel TCP port      |
| `MAGIC_BYTES`   | `0xBE57`                                    | Protocol identifier (LE)    |
| `MAX_KEY_SIZE`  | `64`                                        | Max key length (bytes)      |
| `MAX_VALUE_SIZE`| `10485760` (10 MB)                          | Max value size (bytes)      |
| `TCP_TIMEOUT_MS`| `10000` (10 s)                              | Timeout for TCP round-trip  |

### Moving to `env` bindings

To avoid redeployment on tunnel URL changes:

1. Add to `wrangler.toml`:
   ```toml
   [vars]
   BACKEND_HOST = "your-tunnel.a.free.pinggy.link"
   BACKEND_PORT = "32779"
   ```
2. Replace constants in `worker.js`:
   ```js
   const BACKEND_HOST = env.BACKEND_HOST;
   const BACKEND_PORT = parseInt(env.BACKEND_PORT, 10);
   ```

---

## 💻 Usage Examples

**Base URL:** `https://tcp-dt-engine.app140226c.workers.dev`

### Write a string

```bash
curl -X POST "$BASE/set/user:1001" \
  -H "Content-Type: text/plain" \
  -d "Alice"
```

### Read a string

```bash
curl "$BASE/get/user:1001"
# {"key":"user:1001","value":"Alice"}
```

### Write JSON

```bash
curl -X POST "$BASE/set/config:app" \
  -H "Content-Type: application/json" \
  -d '{"theme":"dark","lang":"en"}'
```

### Read JSON

```bash
curl "$BASE/get/config:app" | jq .value
# {"theme":"dark","lang":"en"}
```

### Increment a counter

```bash
curl -X POST "$BASE/incr/page:views"
# {"ok":true,"key":"page:views","new_value":1,"delta":1}

curl -X POST "$BASE/incr/page:views" \
  -H "Content-Type: application/json" \
  -d '{"delta":10}'
# {"ok":true,"key":"page:views","new_value":11,"delta":10}
```

### Read a counter (correct way)

```bash
curl "$BASE/counter/page:views"
# {"key":"page:views","value":11}
```

### Read a counter (wrong way — produces garbage)

```bash
curl "$BASE/get/page:views"
# {"key":"page:views","value":"\u000b\u0000\u0000\u0000\u0000\u0000\u0000\u0000"}
```

### Decrement a counter

```bash
curl -X POST "$BASE/incr/page:views" \
  -H "Content-Type: application/json" \
  -d '{"delta":-3}'
# {"ok":true,"key":"page:views","new_value":8,"delta":-3}
```

### Delete a key

```bash
curl -X DELETE "$BASE/delete/user:1001"
# {"ok":true,"key":"user:1001"}
```

### Upload binary data

```bash
curl -X POST "$BASE/set/avatar:1001" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @avatar.png
```

### Read binary data

```bash
curl "$BASE/get/avatar:1001" | jq -r .value | base64 -d > avatar_downloaded.png
```

### Check backend stats

```bash
curl "$BASE/stats" | jq .
```

### Trigger cache eviction

```bash
curl -X POST "$BASE/evict"
```

---

## ⚠️ Error Handling

All errors return JSON with an `error` field and optional `detail` or `backend` context.

### Client errors (4xx)

**`400 Bad Request`** — invalid key size
```json
{ "error": "key must be 1-64 bytes (UTF-8 encoded)" }
```

**`404 Not Found`** — key does not exist
```json
{ "error": "key not found" }
```

**`413 Payload Too Large`** — value > 10 MB
```json
{ "error": "value exceeds max size (10485760 bytes)" }
```

**`422 Unprocessable Entity`** — wrong endpoint for value type
```json
{
  "error": "not a counter",
  "detail": "value is 5 bytes (expected exactly 8)"
}
```

### Server errors (5xx)

**`500 Internal Server Error`** — BSEngine-level failure
```json
{
  "error": "incr failed -- key may hold a non-numeric value; DELETE it first"
}
```

**`502 Bad Gateway`** — protocol mismatch
```json
{
  "error": "internal gateway error",
  "detail": "Protocol error: bad magic 0x1234 (expected 0xbe57)",
  "backend": "akxpa-114-8-218-205.a.free.pinggy.link:44771"
}
```

**`503 Service Unavailable`** — TCP connection failed
```json
{
  "error": "backend unreachable",
  "detail": "connect ECONNREFUSED",
  "backend": "akxpa-114-8-218-205.a.free.pinggy.link:44771"
}
```

---

## 📊 Observability

### Health check

```bash
# Passes if latency < 500ms
curl -sf "https://tcp-dt-engine.app140226c.workers.dev/ping" | jq '.ok'
```

### Metrics snapshot

```bash
curl -s "https://tcp-dt-engine.app140226c.workers.dev/stats" | jq .
```

```json
{
  "keys": 18423,
  "total_ops": 4291032,
  "total_pages": 512,
  "cached_pages": 348,
  "idle_secs": 0
}
```

### Cloudflare Worker logs

```bash
npx wrangler tail --format pretty
```

### Suggested alerting thresholds

| Metric               | Warning    | Critical   |
|----------------------|------------|------------|
| `/ping` latency_ms   | > 200 ms   | > 1 000 ms |
| `idle_secs`          | > 240 s    | > 600 s    |
| `cached_pages`       | < 100      | < `MinCachePages` (64) |
| HTTP 503 rate        | > 1%       | > 5%       |

---

## 🚢 Deployment

### Wrangler deploy (recommended)

```bash
# Production
npx wrangler deploy

# Staging (with environment)
npx wrangler deploy --env staging
```

### Multi-environment `wrangler.toml`

```toml
name            = "bsengine-gateway"
main            = "worker.js"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]

[env.staging.vars]
BACKEND_HOST = "staging-tunnel.a.free.pinggy.link"
BACKEND_PORT = "32779"

[env.production.vars]
BACKEND_HOST = "prod-tunnel.a.free.pinggy.link"
BACKEND_PORT = "32779"
```

> **Note:** `BACKEND_HOST` and `BACKEND_PORT` are currently hardcoded constants in `worker.js`. Refactor to `env.BACKEND_HOST` / `env.BACKEND_PORT` if you need per-environment configuration without redeployment.

### CI/CD (GitHub Actions)

```yaml
# .github/workflows/deploy.yml
name: Deploy Worker

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: npx wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

---

## 🔧 Troubleshooting

### `503 backend unreachable`

The TCP connection to Pinggy failed. Check in order:

1. **Is BSEngine running?**
   ```bash
   ps aux | grep main.go   # or: ps aux | grep bsengine
   ```
2. **Is the Pinggy tunnel active?**
   ```bash
   # Restart tunnel
   ssh -p 443 -R0:localhost:7070 -L4300:localhost:4300 \
     qr@a.pinggy.io tcp+tls
   ```
3. **Did the Pinggy hostname change?**
   Free Pinggy tunnels reassign hostnames on reconnect. Update `BACKEND_HOST` and redeploy.
4. **Local TCP test:**
   ```bash
   nc -zv zgyie-114-8-218-205.a.free.pinggy.link 32779
   ```

---

### `502 protocol error: unexpected magic`

Magic byte mismatch in the TCP response. Possible causes:

- An HTTP proxy or load balancer is terminating the connection and returning HTML
- BSEngine binary was updated and `MagicBytes` changed (check `main.go` line ~87)
- Another service is running on that port

---

### `500 incr failed`

`OpIncr` requires the stored value to be exactly 8 bytes (an `int64`). If the key was previously set with a non-numeric value (e.g., a string), you must delete it first:

```bash
curl -X DELETE "$BASE/delete/my:counter"
curl -X POST "$BASE/incr/my:counter"   # starts at 1
```

---

### `422 not a counter`

You're trying to read a non-counter key with `GET /counter/:key`. This endpoint only works for keys created via `POST /incr/:key`. For regular string/JSON/binary values, use `GET /get/:key` instead.

```bash
# Wrong
curl "$BASE/counter/user:name"
# {"error":"not a counter","detail":"value is 5 bytes (expected exactly 8)"}

# Correct
curl "$BASE/get/user:name"
# {"key":"user:name","value":"Alice"}
```

---

### Counter reads return garbage with `/get/:key`

Keys written via `POST /incr/:key` are stored as raw 8-byte little-endian int64 (matching `main.go` encoding). Reading them via `GET /get/:key` decodes the bytes as UTF-8 text, producing output like `"\u0015\u0000..."`. 

**Solution:** Use the dedicated `GET /counter/:key` endpoint instead:

```bash
# Wrong — produces garbage
curl "$BASE/get/page:views"
# {"key":"page:views","value":"\u0015\u0000\u0000\u0000\u0000\u0000\u0000\u0000"}

# Correct — decodes as int64
curl "$BASE/counter/page:views"
# {"key":"page:views","value":21}
```

---

### `compatibility_flags` error in Wrangler

The TCP Sockets API (`cloudflare:sockets`) requires `nodejs_compat`. If you see:

```
✘ [ERROR] Global "connect" is not defined
```

Add to `wrangler.toml`:
```toml
compatibility_flags = ["nodejs_compat"]
```

---

### Binary value returned as base64

Values stored via `application/octet-stream` are decoded byte-by-byte. If the bytes are not valid UTF-8, the Worker falls back to base64 encoding in the JSON response. To decode in JS:

```js
const binary = Uint8Array.from(atob(value), c => c.charCodeAt(0));
```

---

## 🔐 Security Considerations

> This Worker is deployed as a **public endpoint**. Consider the following before production use.

**Authentication** — the Worker has no built-in auth layer. Add a shared-secret header check or Cloudflare Access policy:

```js
// In worker.js fetch handler — add before route dispatch
const token = request.headers.get("X-API-Key");
if (token !== env.API_KEY) {
  return jsonResponse({ error: "unauthorized" }, 401);
}
```

**Pinggy tunnel exposure** — the free Pinggy tunnel is publicly resolvable. Anyone who discovers the hostname can connect directly to your BSEngine TCP port. Mitigate by:
- Using a paid Pinggy plan with IP allowlisting
- Adding a password/token check inside BSEngine itself
- Rotating the tunnel URL frequently

**Key validation** — the gateway rejects keys > 64 bytes before opening a TCP connection. Values > 10 MB are also rejected early. These match the limits enforced by BSEngine itself.

**CORS** — the Worker currently allows `*` (all origins). Restrict to specific origins in production:
```js
"access-control-allow-origin": "https://your-frontend.com",
```

**No persistent connections** — every HTTP request opens and closes a fresh TCP connection. This avoids state leakage between requests but adds per-request TCP handshake latency (~1–5 ms to Pinggy).

---

## 🗺️ Roadmap

- [ ] Connection pooling via Durable Objects for reduced TCP overhead
- [ ] `BACKEND_HOST` / `BACKEND_PORT` via `env` bindings (no hardcode)
- [ ] Auth middleware (API key via `env.API_KEY` secret)
- [ ] `GET /keys` — list all keys (requires engine-side implementation)
- [ ] `GET /get/:key` streaming for large binary blobs
- [ ] Metrics export to Cloudflare Analytics Engine

---

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Commit with [Conventional Commits](https://www.conventionalcommits.org/): `git commit -m "feat: add key listing endpoint"`
4. Push and open a Pull Request

Please ensure:
- All binary protocol constants stay in sync with `main.go`
- New endpoints are documented in both code comments and this README
- Error responses follow the existing `{ error, detail?, backend? }` shape

---

## 📄 License

MIT © 2025 — see [LICENSE](LICENSE) for details.

---

<div align="center">

**BSEngine** · Slotted-page KV store with WAL, LRU buffer pool, and binary TCP protocol  
**Worker** · HTTP/JSON gateway deployed on Cloudflare's global edge network

<br/>

Made with ☕ and binary framing

</div>