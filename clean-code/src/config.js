/**
 * BSEngine Connection Configuration
 *
 * ⚠️  Edit BSENGINE_HOST and BSENGINE_PORT to point at your BSEngine instance.
 *
 * These values are hardcoded intentionally so that Cloudflare Workers can
 * establish raw TCP connections without needing dynamic environment resolution.
 * In a production environment you may also bind these via wrangler.toml secrets,
 * but the constants below are the single authoritative source.
 */

/** IPv4 or IPv6 address of the BSEngine TCP server. */
export const BSENGINE_HOST = '127.0.0.1';

/** TCP port BSEngine is listening on (default: 7070). */
export const BSENGINE_PORT = 7070;

// ── Engine-level limits (must mirror BSEngine constants) ──────────────────
// Kept here so HTTP validation rejects oversized payloads before
// a TCP connection is even opened, saving round-trip cost.

/** Maximum key size in bytes (BSEngine enforces 64 B at the TCP layer). */
export const MAX_KEY_SIZE = 64;

/** Maximum value size in bytes (BSEngine enforces 10 MiB). */
export const MAX_VALUE_SIZE = 10 * 1024 * 1024; // 10 MiB
