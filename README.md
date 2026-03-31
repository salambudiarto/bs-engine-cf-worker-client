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

---

### `POST /set/:key`

Write (upsert) a value at `:key`. Creates the key if absent; overwrites if present.

**Path Parameters**

| Parameter | Type   | Constraints        | Description  |
|-----------|--------|--------------------|--------------|
| `key`     | string | 1–64 chars, URL-encoded | Storage key |

**Request Body**

| Content-Type                | Body interpretation              |
|-----------------------------|----------------------------------|
| `text/plain` *(default)*    | Raw UTF-8 string stored as-is    |
| `application/json`          | JSON string stored as-is (raw)   |
| `application/octet-stream`  | Binary blob stored verbatim      |

**Response `200`**
```json
{
  "ok": true,
  "key": "user:1001"
}
```

**Response `413`** — value exceeds 10 MB:
```json
{ "error": "value exceeds max size (10485760 bytes)" }
```

---

### `DELETE /delete/:key`

Permanently delete a key from the store.

**Response `200`**
```json
{
  "ok": true,
  "key": "user:1001"
}
```

**Response `404`**
```json
{ "error": "key not found" }
```

---

### `POST /incr/:key`

Atomically increment (or decrement) a numeric counter stored at `:key`. The engine manages the counter as a native `int64`. If the key does not exist, it is initialised to `0` before the delta is applied.

**Request Body** *(optional JSON)*
```json
{ "delta": 5 }
```

| Field   | Type    | Default | Description                            |
|---------|---------|---------|----------------------------------------|
| `delta` | integer | `1`     | Amount to add (negative values subtract) |

**Response `200`**
```json
{
  "ok": true,
  "key": "counter:pageviews",
  "new_value": 1042,
  "delta": 1
}
```

---

### `GET /stats`

Return live engine metrics. Useful for health dashboards and alerting.

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

| Field          | Type    | Description                                      |
|----------------|---------|--------------------------------------------------|
| `keys`         | integer | Total distinct keys in the store                 |
| `total_ops`    | integer | Cumulative operation count since start           |
| `total_pages`  | integer | Number of 4 KiB pages allocated on disk          |
| `cached_pages` | integer | Pages currently resident in the LRU buffer pool  |
| `idle_secs`    | integer | Seconds since the last engine operation          |

---

### `POST /evict`

Trigger a manual cache eviction cycle on the backend. The engine's LRU pool is shrunk, the index is pruned, and `runtime.GC()` + `debug.FreeOSMemory()` are called. The operation runs **asynchronously** inside the Go process; the Worker responds immediately.

Useful in orchestration scripts, post-batch cleanup, or memory-constrained environments.

**Response `200`**
```json
{
  "ok": true,
  "message": "eviction triggered in background"
}
```

---

## 🚀 Quick Start

### Prerequisites

- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) `>= 3.x`
- Cloudflare account with Workers enabled
- BSEngine running locally and exposed via [Pinggy](https://pinggy.io/) TCP tunnel

### 1 — Clone and install

```bash
git clone https://github.com/<your-org>/bsengine-worker.git
cd bsengine-worker
npm install
```

### 2 — Configure backend address

Edit `worker.js` and update the two constants at the top:

```js
const BACKEND_HOST = "zgyie-114-8-218-205.a.free.pinggy.link"; // your Pinggy hostname
const BACKEND_PORT = 32779;                                      // your Pinggy port
```

> **Tip:** Use [Wrangler Secrets](https://developers.cloudflare.com/workers/configuration/secrets/) or `[vars]` in `wrangler.toml` for production deployments instead of hardcoding.

### 3 — `wrangler.toml`

```toml
name            = "bsengine-gateway"
main            = "worker.js"
compatibility_date = "2024-09-23"

# Required for cloudflare:sockets TCP API
compatibility_flags = ["nodejs_compat"]
```

### 4 — Local development

```bash
npx wrangler dev
```

The Worker starts at `http://localhost:8787`. BSEngine must be reachable from your machine.

### 5 — Deploy to Cloudflare

```bash
npx wrangler deploy
```

---

## ⚙️ Configuration

| Constant          | Location    | Default                                    | Description                        |
|-------------------|-------------|--------------------------------------------|------------------------------------|
| `BACKEND_HOST`    | `worker.js` | `zgyie-114-8-218-205.a.free.pinggy.link`   | Pinggy hostname for TCP tunnel     |
| `BACKEND_PORT`    | `worker.js` | `32779`                                    | Pinggy external TCP port           |
| `MAGIC_BYTES`     | `worker.js` | `0xBE57`                                   | Must match `MagicBytes` in main.go |
| `MAX_KEY_SIZE`    | `worker.js` | `64`                                       | Must match `MaxKeySize` in main.go |
| `MAX_VALUE_SIZE`  | `worker.js` | `10485760` (10 MB)                         | Must match `MaxValueSize` in main.go |

### Environment Variables (BSEngine backend)

These are consumed by `main.go`, not the Worker:

| Variable               | Default       | Description                       |
|------------------------|---------------|-----------------------------------|
| `BSENGINE_ADDR`        | `:7070`       | TCP listen address                |
| `BSENGINE_DATA_PATH`   | `data.bin`    | Storage file path                 |
| `BSENGINE_WAL_PATH`    | `wal.bin`     | WAL file path                     |
| `BSENGINE_MEM_LIMIT_MB`| *(unset)*     | Soft RSS cap via `GOMEMLIMIT`     |
| `BSENGINE_GOGC`        | `50`          | GC aggressiveness (lower = leaner)|

---

## 💡 Usage Examples

### cURL

```bash
BASE="https://tcp-dt-engine.app140226c.workers.dev"

# Ping
curl "$BASE/ping"

# Set a string value
curl -X POST "$BASE/set/user:1001" \
  -H "Content-Type: text/plain" \
  -d "Alice"

# Set a JSON document
curl -X POST "$BASE/set/config:app" \
  -H "Content-Type: application/json" \
  -d '{"theme":"dark","lang":"id"}'

# Get a value
curl "$BASE/get/user:1001"

# Increment a counter (delta defaults to 1)
curl -X POST "$BASE/incr/counter:pageviews"

# Increment by a custom delta
curl -X POST "$BASE/incr/counter:pageviews" \
  -H "Content-Type: application/json" \
  -d '{"delta": 10}'

# Decrement (negative delta)
curl -X POST "$BASE/incr/counter:stock" \
  -H "Content-Type: application/json" \
  -d '{"delta": -1}'

# Delete a key
curl -X DELETE "$BASE/delete/user:1001"

# Engine metrics
curl "$BASE/stats"

# Manual cache eviction
curl -X POST "$BASE/evict"
```

### JavaScript (Fetch API)

```js
const API = "https://tcp-dt-engine.app140226c.workers.dev";

// Write
await fetch(`${API}/set/session:abc`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ userId: 42, role: "admin" }),
});

// Read
const res = await fetch(`${API}/get/session:abc`);
const { key, value } = await res.json();
console.log(value); // { userId: 42, role: "admin" }

// Atomic counter
const { new_value } = await (
  await fetch(`${API}/incr/visits`, { method: "POST" })
).json();
console.log("Total visits:", new_value);
```

### Python (httpx)

```python
import httpx, json

BASE = "https://tcp-dt-engine.app140226c.workers.dev"

with httpx.Client() as c:
    # Store binary blob
    c.post(f"{BASE}/set/file:logo",
           content=open("logo.png", "rb").read(),
           headers={"Content-Type": "application/octet-stream"})

    # Read back
    r = c.get(f"{BASE}/get/file:logo").json()
    # r["value"] is base64-encoded for binary data
    import base64
    data = base64.b64decode(r["value"])

    # Stats
    stats = c.get(f"{BASE}/stats").json()
    print(f"Keys: {stats['keys']}  Ops: {stats['total_ops']}")
```

---

## ⚠️ Error Handling

The Worker returns structured JSON errors with appropriate HTTP status codes.

| HTTP | `error` field value      | Root cause                                        |
|------|--------------------------|---------------------------------------------------|
| `400`| `key must be 1–64 chars` | Key missing, empty, or exceeds 64-byte limit      |
| `404`| `key not found`          | BSEngine returned `STATUS_NOT_FOUND` (0x01)       |
| `413`| `value exceeds max size` | Request body > 10 MB before TCP connection opens  |
| `500`| `engine error`           | BSEngine returned `STATUS_ERROR` (0x02)           |
| `500`| `internal error`         | Unexpected Worker exception                       |
| `502`| `protocol error`         | Bad magic bytes in TCP response — version mismatch|
| `503`| `backend unreachable`    | TCP connect failed — tunnel down or BSEngine not running |

**Error response shape:**
```json
{
  "error": "backend unreachable",
  "detail": "Connection refused",
  "backend": "zgyie-114-8-218-205.a.free.pinggy.link:32779"
}
```

---

## 📊 Observability

### Health check (automated)

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