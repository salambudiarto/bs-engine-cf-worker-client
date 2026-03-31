# Step-by-Step: VSCode → Cloudflare Worker

---

## Yang Dibutuhkan

- [Node.js](https://nodejs.org) v18+ sudah terinstall
- [VSCode](https://code.visualstudio.com) sudah terinstall
- Akun [Cloudflare](https://cloudflare.com) (gratis)
- BSEngine sudah berjalan di server

---

## Step 1 — Buat Folder Project

Buka terminal di VSCode (`Ctrl + `` ` ``), lalu:

```bash
mkdir bsengine-worker
cd bsengine-worker
```

Pindahkan semua file yang sudah didownload ke folder ini.

---

## Step 2 — Jalankan Setup Script

```bash
chmod +x setup.sh
./setup.sh
```

Script ini otomatis merapihkan file ke folder yang benar dan menjalankan `npm install`.

---

## Step 3 — Edit IP & Port BSEngine

Buka file `src/config.js` di VSCode, ganti IP dan port sesuai server kamu:

```js
export const BSENGINE_HOST = '123.456.789.0';  // ← IP server BSEngine
export const BSENGINE_PORT = 7070;              // ← port (default 7070)
```

Simpan file (`Ctrl + S`).

---

## Step 4 — Login ke Cloudflare

```bash
npx wrangler login
```

Browser akan terbuka → klik **Allow** untuk memberi akses Wrangler ke akun Cloudflare kamu.

---

## Step 5 — Test Lokal (Opsional)

Pastikan BSEngine sudah berjalan, lalu:

```bash
npm run dev
```

Buka browser ke `http://localhost:8787/ping` — kalau muncul `{"ok":true}` berarti sudah terhubung.

Tekan `Ctrl + C` untuk stop.

---

## Step 6 — Deploy

```bash
npm run deploy
```

Selesai! Output akan menampilkan URL Worker kamu:

```
https://bsengine-worker.<subdomain>.workers.dev
```

---

## Verifikasi

```bash
curl https://bsengine-worker.<subdomain>.workers.dev/ping
# → {"ok":true,"message":"BSEngine is reachable"}
```

---

## Perintah Berguna

| Perintah | Fungsi |
|----------|--------|
| `npm run dev` | Jalankan Worker secara lokal |
| `npm run deploy` | Deploy ke Cloudflare |
| `npm run tail` | Lihat log Worker secara live |
