# BSEngine Worker — Full Guide Documentation

**Version:** 1.0.0  
**Compatibility:** Cloudflare Workers · BSEngine v4.0.0  
**Date:** 31 March 2026

---

## Daftar Isi

1. [Gambaran Sistem](#1-gambaran-sistem)
2. [Arsitektur](#2-arsitektur)
3. [Struktur File & Folder](#3-struktur-file--folder)
4. [Konfigurasi](#4-konfigurasi)
5. [Cara Setup (Quickstart)](#5-cara-setup-quickstart)
6. [Referensi API HTTP](#6-referensi-api-http)
7. [Contoh Penggunaan (curl)](#7-contoh-penggunaan-curl)
8. [Contoh Penggunaan (JavaScript / fetch)](#8-contoh-penggunaan-javascript--fetch)
9. [Cara Kerja Internal](#9-cara-kerja-internal)
10. [Error Handling](#10-error-handling)
11. [Deployment ke Cloudflare](#11-deployment-ke-cloudflare)
12. [Pengembangan Lokal](#12-pengembangan-lokal)
13. [Catatan Penting & Batasan](#13-catatan-penting--batasan)

---

## 1. Gambaran Sistem

Worker ini adalah **HTTP gateway** tipis yang duduk di depan BSEngine. Semua operasi berat (WAL, buffer pool, defragmentasi, crash recovery) tetap berjalan sepenuhnya di sisi server BSEngine. Worker hanya bertugas:

```
HTTP Client
    │
    │  GET /keys/mykey
    ▼
Cloudflare Worker  ←── translasi HTTP → binary TCP frame
    │
    │  [binary protocol over TCP]
    ▼
BSEngine Server (Go)
    │
    │  binary response frame
    ▼
Cloudflare Worker  ←── translasi response → JSON / bytes
    │
    │  HTTP Response
    ▼
HTTP Client
```

**Worker tidak menyimpan state apapun.** Setiap request membuka satu koneksi TCP baru ke BSEngine, mengirim satu frame, membaca satu response, lalu menutup koneksi. Ini adalah pola yang benar untuk Cloudflare Workers karena runtime tidak mendukung persistent connection pool antar invocation.

---

## 2. Arsitektur

### Layer Stack

```
┌─────────────────────────────────────────────────────────┐
│                   src/index.js                          │
│              Router & HTTP entry point                  │
│   Menerima request → routing → memanggil handler       │
└──────────────────────┬──────────────────────────────────┘
                       │
         ┌─────────────▼─────────────┐
         │     src/handlers/*.js     │
         │  Satu file per operasi    │
         │  (ping, stats, view, ...)  │
         │  Validasi input HTTP      │
         │  Membentuk response HTTP  │
         └─────────────┬─────────────┘
                       │
         ┌─────────────▼─────────────┐
         │   src/client/bsengine.js  │
         │   sendCommand(op, key, val)│
         │   Buka TCP → kirim frame  │
         │   → baca response → tutup │
         └──────┬──────────┬─────────┘
                │          │
    ┌───────────▼──┐  ┌────▼──────────────┐
    │ src/client/  │  │ src/protocol/     │
    │ stream.js    │  │ frame.js          │
    │ ExactReader  │  │ buildFrame()      │
    │ (buffered    │  │ parseResponseHeader│
    │  byte reads) │  │ constants.js      │
    └──────────────┘  └───────────────────┘
                       │
         ┌─────────────▼─────────────┐
         │    cloudflare:sockets     │
         │    connect(host, port)    │
         │    Raw TCP socket API     │
         └─────────────┬─────────────┘
                       │
         ┌─────────────▼─────────────┐
         │    BSEngine TCP Server    │
         │    (Go binary, port 7070) │
         └───────────────────────────┘
```

### Prinsip Desain

| Prinsip | Implementasi |
|---------|-------------|
| **Single Responsibility** | Setiap file punya satu tanggung jawab (routing, framing, transport, validation, response) |
| **Separation of Concerns** | Handler tidak tahu tentang TCP; client tidak tahu tentang HTTP |
| **Fail Fast** | Validasi input di HTTP layer sebelum membuka koneksi TCP |
| **Stateless** | Worker tidak menyimpan state — setiap request independen |
| **Gateway Pattern** | Worker tidak melakukan komputasi bisnis, hanya translasi protokol |

---

## 3. Struktur File & Folder

Struktur setelah menjalankan `./setup.sh`:

```
bsengine-worker/
│
├── src/
│   │
│   ├── index.js                 ← Entry point Worker & URL router
│   ├── config.js                ← ⚙️  Konfigurasi IP & port (edit di sini)
│   │
│   ├── protocol/
│   │   ├── constants.js         ← Magic bytes, opcode enum, status enum
│   │   └── frame.js             ← Build binary request frame & parse response header
│   │
│   ├── client/
│   │   ├── stream.js            ← ExactReader: buffered exact-byte TCP stream reader
│   │   └── bsengine.js          ← sendCommand(): buka TCP, kirim, baca, tutup
│   │
│   ├── handlers/
│   │   ├── ping.js              ← GET /ping → OpPing
│   │   ├── stats.js             ← GET /stats → OpStats
│   │   ├── view.js              ← GET /keys/:key → OpView
│   │   ├── upsert.js            ← PUT /keys/:key → OpUpsert
│   │   ├── delete.js            ← DELETE /keys/:key → OpDelete
│   │   └── incr.js              ← POST /keys/:key/incr → OpIncr
│   │
│   └── utils/
│       ├── http.js              ← Response factory (jsonResponse, bytesResponse, dll)
│       └── validate.js          ← Validasi key & value size
│
├── wrangler.toml                ← Konfigurasi Cloudflare Worker
├── package.json                 ← Script dev/deploy & dependency Wrangler
├── setup.sh                     ← Script perapihan folder (jalankan sekali)
└── full-guide-doc-worker.md     ← Dokumentasi ini
```

### Penjelasan Setiap File

#### `src/index.js` — Router
Titik masuk utama Worker. Menerima semua HTTP request, mencocokkan URL pattern dengan regex, dan mendelegasikan ke handler yang tepat. **Tidak mengandung logika bisnis apapun.**

#### `src/config.js` — Konfigurasi
**Satu-satunya file yang perlu diedit** untuk mengganti target BSEngine:
```js
export const BSENGINE_HOST = '127.0.0.1';  // ← ganti ini
export const BSENGINE_PORT = 7070;          // ← dan ini
```

#### `src/protocol/constants.js` — Konstanta Protokol
Semua magic number, opcode, dan status code. Nilainya identik dengan konstanta di `main.go` BSEngine. Jangan diubah kecuali versi protokol BSEngine berubah.

#### `src/protocol/frame.js` — Binary Frame Builder
Mengimplementasikan serialisasi request frame dan parsing response header sesuai spesifikasi wire protocol BSEngine (little-endian, 12-byte request header, 11-byte response header).

#### `src/client/stream.js` — ExactReader
Cloudflare Workers TCP socket mengembalikan data sebagai `ReadableStream<Uint8Array>` dengan chunk berukuran arbitrari. `ExactReader` menjamin pembacaan sejumlah byte yang tepat, mem-buffer sisa chunk untuk pembacaan berikutnya.

#### `src/client/bsengine.js` — TCP Client
Fungsi `sendCommand(op, keyBytes, valBytes)` — satu-satunya titik komunikasi dengan BSEngine. Membuka koneksi, mengirim frame, membaca response, menutup socket.

#### `src/handlers/*.js` — HTTP Handlers
Satu file per operasi. Setiap handler: validasi input → panggil `sendCommand` → ubah response BSEngine menjadi HTTP response.

#### `src/utils/http.js` — HTTP Response Helpers
Factory function untuk semua tipe response HTTP yang digunakan oleh handler. Memastikan format JSON konsisten di seluruh API.

#### `src/utils/validate.js` — Validasi Input
Validasi key dan value size sebelum koneksi TCP dibuka. Mencegah request yang pasti gagal sampai ke BSEngine.

---

## 4. Konfigurasi

### Mengganti Target BSEngine

Edit file `src/config.js`:

```js
// src/config.js

/** IPv4 atau IPv6 address BSEngine TCP server. */
export const BSENGINE_HOST = '10.0.0.5';  // ← IP server kamu

/** Port TCP BSEngine (default BSEngine: 7070). */
export const BSENGINE_PORT = 7070;
```

**Tidak ada file lain yang perlu diubah** untuk mengganti target server.

### Menggunakan Environment Variable (Opsional)

Jika ingin IP/port dikonfigurasi dari luar (misalnya berbeda per environment), modifikasi `src/config.js` dan `src/client/bsengine.js`:

```js
// src/config.js — versi env-aware
export const BSENGINE_HOST = typeof WORKER_BSENGINE_HOST !== 'undefined'
  ? WORKER_BSENGINE_HOST
  : '127.0.0.1';

export const BSENGINE_PORT = typeof WORKER_BSENGINE_PORT !== 'undefined'
  ? parseInt(WORKER_BSENGINE_PORT, 10)
  : 7070;
```

Lalu di `wrangler.toml`:
```toml
[vars]
WORKER_BSENGINE_HOST = "10.0.0.5"
WORKER_BSENGINE_PORT = "7070"
```

---

## 5. Cara Setup (Quickstart)

### Prasyarat

- **Node.js** v18 atau lebih baru (untuk Wrangler CLI)
- **Akun Cloudflare** (gratis) — untuk deploy
- **BSEngine** sudah berjalan dan dapat dijangkau dari Worker

### Langkah-langkah

**1. Download semua file**

Letakkan semua file hasil download dalam satu folder kosong, misalnya `bsengine-worker/`.

**2. Jalankan setup script**

```bash
cd bsengine-worker/
chmod +x setup.sh
./setup.sh
```

Script ini akan:
- Membuat struktur folder `src/`
- Memindahkan setiap file ke lokasi yang benar
- Menjalankan `npm install` untuk menginstall Wrangler

**3. Edit konfigurasi**

```bash
# Ganti IP dan port BSEngine kamu
nano src/config.js
```

**4. Test secara lokal**

```bash
npm run dev
# → Worker berjalan di http://localhost:8787
```

**5. Test koneksi**

```bash
curl http://localhost:8787/ping
# → {"ok":true,"message":"BSEngine is reachable"}
```

**6. Deploy ke Cloudflare**

```bash
npm run deploy
# → Deployed to https://bsengine-worker.<subdomain>.workers.dev
```

---

## 6. Referensi API HTTP

### Ringkasan Endpoint

| Method | Path | Operasi BSEngine | Deskripsi |
|--------|------|-----------------|-----------|
| `GET` | `/ping` | `OpPing` | Health check / liveness probe |
| `GET` | `/stats` | `OpStats` | Metrics engine (keys, ops, pages) |
| `GET` | `/keys/:key` | `OpView` | Ambil value dari key |
| `PUT` | `/keys/:key` | `OpUpsert` | Simpan atau timpa value |
| `DELETE` | `/keys/:key` | `OpDelete` | Hapus key |
| `POST` | `/keys/:key/incr` | `OpIncr` | Increment counter int64 secara atomic |

---

### `GET /ping`

**Deskripsi:** Kirim round-trip ping ke BSEngine. Gunakan sebagai liveness check.

**Request:**
```
GET /ping
```

**Response sukses (200):**
```json
{
  "ok": true,
  "message": "BSEngine is reachable"
}
```

**Response gagal (503):**
```json
{
  "error": "BSEngine unreachable",
  "detail": "connect ECONNREFUSED 127.0.0.1:7070"
}
```

---

### `GET /stats`

**Deskripsi:** Ambil metrics engine dari BSEngine. Berguna untuk monitoring.

**Request:**
```
GET /stats
```

**Response sukses (200):**
```json
{
  "keys":       1523,
  "totalOps":   48291,
  "totalPages": 12
}
```

| Field | Tipe | Deskripsi |
|-------|------|-----------|
| `keys` | `number` | Jumlah key aktif dalam index |
| `totalOps` | `number` | Total operasi sejak checkpoint terakhir |
| `totalPages` | `number` | Total halaman dalam file data |

---

### `GET /keys/:key`

**Deskripsi:** Mengambil value yang tersimpan di `key`.

**Request:**
```
GET /keys/username:42
```

**Response sukses (200):**
```
Content-Type: application/octet-stream

<raw bytes of stored value>
```

Value dikembalikan sebagai bytes mentah (`application/octet-stream`). Jika value yang disimpan adalah teks UTF-8, client dapat membacanya sebagai string.

**Response tidak ditemukan (404):**
```json
{
  "error": "Not Found",
  "key": "username:42"
}
```

**Batasan key:**
- Tidak boleh kosong
- Maksimal 64 byte (UTF-8 encoded)
- Tidak boleh mengandung karakter `/`

---

### `PUT /keys/:key`

**Deskripsi:** Menyimpan atau menimpa value di `key`. Operasi ini idempotent — jika key sudah ada, value-nya diganti.

**Request:**
```
PUT /keys/username:42
Content-Type: text/plain   (atau apapun — BSEngine menyimpan raw bytes)

JohnDoe
```

Body boleh berupa teks, JSON, atau binary — BSEngine menyimpannya tanpa interpretasi.

**Response sukses (200):**
```json
{
  "stored": true,
  "key":    "username:42",
  "bytes":  7
}
```

**Response error (400) — value terlalu besar:**
```json
{
  "error":   "Bad Request",
  "message": "Value is 11534336 bytes — exceeds BSEngine limit of 10 MiB"
}
```

**Batasan value:**
- Maksimal 10 MiB (10,485,760 bytes)

---

### `DELETE /keys/:key`

**Deskripsi:** Menghapus key dari BSEngine. Mengembalikan 404 jika key tidak ditemukan.

**Request:**
```
DELETE /keys/username:42
```

**Response sukses (200):**
```json
{
  "deleted": true,
  "key":     "username:42"
}
```

**Response tidak ditemukan (404):**
```json
{
  "error": "Not Found",
  "key":   "username:42"
}
```

---

### `POST /keys/:key/incr`

**Deskripsi:** Menambahkan `delta` ke counter integer 64-bit yang tersimpan di `key` secara **atomic**. Jika key belum ada, BSEngine menginisialisasi ke 0 sebelum menerapkan delta.

**Request:**
```
POST /keys/counter:pageviews/incr
Content-Type: application/json

{"delta": 1}
```

| Field | Tipe | Default | Deskripsi |
|-------|------|---------|-----------|
| `delta` | `integer` | `1` | Nilai yang ditambahkan. Boleh negatif untuk decrement. |

**Response sukses (200):**
```json
{
  "key":      "counter:pageviews",
  "newValue": 1024
}
```

**Response error (400) — body tidak valid:**
```json
{
  "error":   "Bad Request",
  "message": "Body must be valid JSON, e.g. {\"delta\": 1} or {\"delta\": -5}"
}
```

**Catatan:** `newValue` adalah nilai setelah increment. Range: -9,007,199,254,740,991 hingga 9,007,199,254,740,991 (safe integer JavaScript).

---

## 7. Contoh Penggunaan (curl)

### Ping

```bash
curl https://bsengine-worker.example.workers.dev/ping
```

### Stats

```bash
curl https://bsengine-worker.example.workers.dev/stats
```

### Simpan nilai teks

```bash
curl -X PUT \
  -H "Content-Type: text/plain" \
  -d "Hello, World!" \
  https://bsengine-worker.example.workers.dev/keys/greeting
```

### Simpan nilai JSON

```bash
curl -X PUT \
  -H "Content-Type: application/json" \
  -d '{"name":"Budi","age":30}' \
  https://bsengine-worker.example.workers.dev/keys/user:101
```

### Ambil nilai

```bash
curl https://bsengine-worker.example.workers.dev/keys/greeting
# → Hello, World!
```

### Ambil nilai JSON

```bash
curl https://bsengine-worker.example.workers.dev/keys/user:101
# → {"name":"Budi","age":30}
```

### Hapus key

```bash
curl -X DELETE \
  https://bsengine-worker.example.workers.dev/keys/greeting
# → {"deleted":true,"key":"greeting"}
```

### Increment counter (mulai dari 0)

```bash
# Tambah 1
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"delta":1}' \
  https://bsengine-worker.example.workers.dev/keys/counter:visits/incr
# → {"key":"counter:visits","newValue":1}

# Tambah 10
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"delta":10}' \
  https://bsengine-worker.example.workers.dev/keys/counter:visits/incr
# → {"key":"counter:visits","newValue":11}

# Kurangi 5
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"delta":-5}' \
  https://bsengine-worker.example.workers.dev/keys/counter:visits/incr
# → {"key":"counter:visits","newValue":6}
```

### Key dengan URL encoding

```bash
# Key: "session:abc 123" (mengandung spasi)
curl -X PUT \
  -d "session-data" \
  "https://bsengine-worker.example.workers.dev/keys/session%3Aabc%20123"
```

### Simpan data binary

```bash
# Simpan file binary
curl -X PUT \
  -H "Content-Type: application/octet-stream" \
  --data-binary @avatar.png \
  https://bsengine-worker.example.workers.dev/keys/avatar:user42
```

---

## 8. Contoh Penggunaan (JavaScript / fetch)

### Helper class BSEngineClient

```js
/**
 * Contoh client JavaScript untuk BSEngine Worker.
 * Bisa digunakan dari browser, Node.js, atau Worker lain.
 */
class BSEngineClient {
  constructor(baseUrl) {
    this.base = baseUrl.replace(/\/$/, '');
  }

  async ping() {
    const res = await fetch(`${this.base}/ping`);
    return res.json();
  }

  async stats() {
    const res = await fetch(`${this.base}/stats`);
    return res.json();
  }

  async get(key) {
    const res = await fetch(`${this.base}/keys/${encodeURIComponent(key)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GET ${key} failed: ${res.status}`);
    return res.arrayBuffer(); // raw bytes
  }

  async getText(key) {
    const buf = await this.get(key);
    return buf ? new TextDecoder().decode(buf) : null;
  }

  async getJson(key) {
    const text = await this.getText(key);
    return text ? JSON.parse(text) : null;
  }

  async set(key, value) {
    const body = typeof value === 'string'
      ? new TextEncoder().encode(value)
      : value instanceof Uint8Array ? value
      : new TextEncoder().encode(JSON.stringify(value));

    const res = await fetch(`${this.base}/keys/${encodeURIComponent(key)}`, {
      method : 'PUT',
      body,
    });
    if (!res.ok) throw new Error(`SET ${key} failed: ${res.status}`);
    return res.json();
  }

  async delete(key) {
    const res = await fetch(`${this.base}/keys/${encodeURIComponent(key)}`, {
      method: 'DELETE',
    });
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`DELETE ${key} failed: ${res.status}`);
    return true;
  }

  async incr(key, delta = 1) {
    const res = await fetch(`${this.base}/keys/${encodeURIComponent(key)}/incr`, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify({ delta }),
    });
    if (!res.ok) throw new Error(`INCR ${key} failed: ${res.status}`);
    const { newValue } = await res.json();
    return newValue;
  }
}

// ── Penggunaan ──────────────────────────────────────────────────────────────

const db = new BSEngineClient('https://bsengine-worker.example.workers.dev');

// Health check
await db.ping();                           // { ok: true, ... }

// Simpan dan ambil string
await db.set('greeting', 'Halo dunia!');
const text = await db.getText('greeting'); // "Halo dunia!"

// Simpan dan ambil JSON
await db.set('user:1', { name: 'Budi', score: 100 });
const user = await db.getJson('user:1');   // { name: 'Budi', score: 100 }

// Atomic counter
const views = await db.incr('counter:pageviews'); // 1
const more  = await db.incr('counter:pageviews', 5); // 6

// Stats
const stats = await db.stats();
console.log(`${stats.keys} keys, ${stats.totalOps} ops`);

// Hapus
await db.delete('greeting'); // true
await db.delete('nonexistent'); // false
```

---

## 9. Cara Kerja Internal

### Alur Request Lengkap: `GET /keys/mykey`

```
1. HTTP Request masuk ke Worker (src/index.js)
   │  GET /keys/mykey
   │
2. Router mencocokkan path pattern /keys/:key
   │  key = "mykey"
   │
3. handleView("mykey") dipanggil (src/handlers/view.js)
   │  validateKey("mykey") → null (valid)
   │  encodeKey("mykey")   → Uint8Array [6d,79,6b,65,79]
   │
4. sendCommand(Op.VIEW, keyBytes) dipanggil (src/client/bsengine.js)
   │
5. buildFrame(0x02, [6d,79,6b,65,79], []) (src/protocol/frame.js)
   │  Hasil frame (17 bytes, little-endian):
   │  [57,BE]         ← Magic 0xBE57 LE
   │  [02]            ← OpView
   │  [01,00,00,00]   ← ReqID=1 LE
   │  [05]            ← KeyLen=5
   │  [00,00,00,00]   ← ValLen=0 LE
   │  [6d,79,6b,65,79]← "mykey"
   │
6. connect({ hostname: '127.0.0.1', port: 7070 })
   │  TCP socket terbuka via cloudflare:sockets
   │
7. writer.write(frame)
   │  Frame dikirim ke BSEngine
   │
8. ExactReader.readExact(11) (src/client/stream.js)
   │  Membaca 11 bytes response header dari TCP stream
   │  BSEngine response header:
   │  [57,BE]          ← Magic
   │  [01,00,00,00]    ← ReqID=1 echoed
   │  [00]             ← Status OK
   │  [0D,00,00,00]    ← DataLen=13 LE
   │
9. ExactReader.readExact(13)
   │  Membaca 13 bytes body: "Hello, Worker"
   │
10. socket.close()
    │
11. handleView menerima { status: 0x00, data: Uint8Array("Hello, Worker") }
    │  status === Status.OK → bytesResponse(data)
    │
12. HTTP Response 200
    Content-Type: application/octet-stream
    Body: Hello, Worker
```

### Binary Protocol Detail

**Request Frame (12-byte header + payload):**

```
Offset  Size  Nilai (contoh)  Keterangan
──────────────────────────────────────────────────────
0       2     57 BE           Magic 0xBE57 little-endian
2       1     02              OpView
3       4     01 00 00 00     ReqID = 1, little-endian uint32
7       1     05              KeyLen = 5
8       4     00 00 00 00     ValLen = 0, little-endian uint32
12      5     6D 79 6B 65 79  "mykey"
```

**Response Frame (11-byte header + body):**

```
Offset  Size  Nilai (contoh)  Keterangan
──────────────────────────────────────────────────────
0       2     57 BE           Magic 0xBE57
2       4     01 00 00 00     ReqID echoed
6       1     00              Status OK
7       4     0D 00 00 00     DataLen = 13
11      13    48 65 6C 6C...  "Hello, Worker"
```

**Semua integer = Little-Endian**, sesuai spesifikasi BSEngine (full-doc.md §3).

---

## 10. Error Handling

### Tabel Status HTTP

| HTTP Status | Kapan Terjadi |
|-------------|--------------|
| `200 OK` | Operasi sukses |
| `400 Bad Request` | Key terlalu panjang, value terlalu besar, body JSON tidak valid |
| `404 Not Found` | Key tidak ditemukan di BSEngine, atau URL tidak dikenali |
| `405 Method Not Allowed` | Method HTTP tidak didukung untuk path tersebut |
| `502 Bad Gateway` | BSEngine mengembalikan status ERROR (0x02) |
| `503 Service Unavailable` | Tidak bisa terhubung ke BSEngine via TCP |

### Format Error Response

Semua error dikembalikan sebagai JSON:

```json
{
  "error": "Pesan error singkat",
  "message": "Detail tambahan (hanya untuk 400)",
  "detail": "Low-level error string (hanya untuk 503)",
  "key": "nama-key (hanya untuk 404 key not found)"
}
```

### Membedakan Error

```js
const res = await fetch('/keys/mykey');

if (res.ok) {
  // 200 — nilai ditemukan
  const data = await res.arrayBuffer();

} else if (res.status === 404) {
  // Key tidak ada di BSEngine
  const body = await res.json();
  console.log('Not found:', body.key);

} else if (res.status === 503) {
  // BSEngine down atau tidak bisa dijangkau
  const body = await res.json();
  console.error('Connection error:', body.detail);

} else if (res.status === 502) {
  // BSEngine menerima request tapi gagal memprosesnya
  // Cek log BSEngine untuk detail
  console.error('Upstream error');
}
```

---

## 11. Deployment ke Cloudflare

### 1. Login ke Cloudflare

```bash
npx wrangler login
```

Browser akan terbuka untuk autentikasi. Ikuti proses OAuth.

### 2. Set konfigurasi target BSEngine

```bash
# Edit langsung
nano src/config.js
```

Pastikan `BSENGINE_HOST` dapat dijangkau dari Cloudflare Workers network (bukan `localhost` atau `127.0.0.1` untuk production).

### 3. Deploy

```bash
npm run deploy
```

Output:
```
⛅️  wrangler 3.x.x
───────────────────
Total Upload: 12.34 KiB / gzip: 4.56 KiB
Uploaded bsengine-worker (1.23 sec)
Published bsengine-worker (0.45 sec)
  https://bsengine-worker.<subdomain>.workers.dev
```

### 4. Verifikasi deployment

```bash
curl https://bsengine-worker.<subdomain>.workers.dev/ping
# → {"ok":true,"message":"BSEngine is reachable"}
```

### 5. Melihat logs real-time

```bash
npm run tail
# → Streaming live logs dari Worker...
```

### Catatan Jaringan untuk Production

Agar Worker dapat menjangkau BSEngine via TCP, server BSEngine harus:

- **Memiliki IP publik** yang dapat diakses dari Cloudflare network, **ATAU**
- **Berada di Cloudflare network** (misalnya VM di server yang menggunakan Cloudflare Tunnel)

Untuk koneksi aman (private network), pertimbangkan menggunakan **Cloudflare Tunnel** (`cloudflared`) yang mengekspos BSEngine ke Workers tanpa membuka port publik.

```bash
# Contoh: ekspos BSEngine via Cloudflare Tunnel
cloudflared tunnel --url tcp://localhost:7070
```

---

## 12. Pengembangan Lokal

### Menjalankan Worker secara lokal

```bash
npm run dev
# → http://localhost:8787
```

Wrangler akan menjalankan Worker secara lokal dengan simulasi runtime Cloudflare.

**Catatan penting:** `cloudflare:sockets` dalam mode `wrangler dev` akan melakukan koneksi TCP nyata ke `BSENGINE_HOST:BSENGINE_PORT`. Pastikan BSEngine sudah berjalan secara lokal:

```bash
# Terminal 1: jalankan BSEngine
./bsengine

# Terminal 2: jalankan Worker
npm run dev

# Terminal 3: test
curl http://localhost:8787/ping
```

### Debugging

Tambahkan `console.log` di handler untuk melihat output di terminal Wrangler:

```js
// Contoh: src/handlers/view.js
export async function handleView(key) {
  console.log('[view] key:', key);
  // ...
}
```

### Hot reload

Wrangler dev secara otomatis reload Worker setiap ada perubahan file di folder `src/`.

---

## 13. Catatan Penting & Batasan

### Koneksi TCP per Request

Setiap HTTP request ke Worker membuka **satu koneksi TCP baru** ke BSEngine, menggunakannya untuk satu operasi, lalu menutupnya. Ini karena Cloudflare Workers tidak mendukung persistent connection pool antar invocation.

**Implikasi performa:**
- Setiap request menanggung overhead TCP handshake (~1–5ms untuk server di cloud)
- Untuk throughput tinggi, pertimbangkan connection pooling di sisi BSEngine (BSEngine mendukung hingga 100 koneksi simultan)
- Untuk workload berat, pertimbangkan batching di sisi aplikasi

### Batas Key

- Maksimal **64 byte** (UTF-8 encoded)
- Key tidak boleh mengandung karakter `/` (digunakan sebagai URL path separator)
- Karakter khusus lain dalam key harus di-URL-encode saat dikirim via HTTP

### Batas Value

- Maksimal **10 MiB** per value
- Cloudflare Workers memiliki batas request body 100 MiB (jauh di atas limit BSEngine)

### Tipe Data Value

BSEngine menyimpan raw bytes tanpa interpretasi. Worker mengembalikan value sebagai `application/octet-stream`. Tipe data sepenuhnya menjadi tanggung jawab aplikasi:

| Kebutuhan | Cara |
|-----------|------|
| String teks | `PUT` dengan `Content-Type: text/plain`, baca dengan `res.text()` |
| JSON | `PUT` dengan JSON string, baca dengan `res.json()` setelah `res.text()` |
| Binary / file | `PUT` dengan `Content-Type: application/octet-stream` |
| Counter | Gunakan `POST /keys/:key/incr` — jangan simpan angka sebagai string lalu increment manual |

### Tidak Ada Autentikasi

Worker ini **tidak mengimplementasikan autentikasi**. Siapapun yang mengetahui URL Worker dapat membaca, menulis, dan menghapus semua data. Untuk production:

- Tambahkan token header (misalnya `Authorization: Bearer <token>`)
- Gunakan Cloudflare Access untuk melindungi endpoint
- Batasi akses via Cloudflare WAF rules

Contoh sederhana token middleware di `src/index.js`:

```js
// Tambahkan di awal fungsi fetch()
const authHeader = request.headers.get('Authorization');
if (authHeader !== `Bearer ${MY_SECRET_TOKEN}`) {
  return jsonResponse({ error: 'Unauthorized' }, 401);
}
```

### Workers Free Tier

Cloudflare Workers free tier memberikan **100,000 request/hari**. Untuk throughput lebih tinggi, upgrade ke Workers Paid ($5/bulan untuk 10 juta request).

---

*BSEngine Worker v1.0.0 — HTTP gateway untuk BSEngine v4.0.0*  
*Dibuat dengan prinsip gateway pattern: Worker tidak menyimpan state, semua logika bisnis tetap di BSEngine.*
