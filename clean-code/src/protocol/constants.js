/**
 * BSEngine Wire-Protocol Constants
 *
 * Source of truth for all magic numbers, opcodes, and status codes.
 * These values mirror the Go constants in main.go exactly — any
 * mismatch here will result in a protocol error or silent data corruption.
 *
 * Reference: §3 — Wire Protocol Reference (full-doc.md)
 */

// ── Frame synchronisation ──────────────────────────────────────────────────

/** 2-byte magic number present in every request and response frame. */
export const MAGIC = 0xbe57;

// ── Request / response frame sizes ────────────────────────────────────────

/** Total size of the binary request header (bytes). Layout: §3.1 */
export const REQUEST_HEADER_SIZE = 12;

/** Total size of the binary response header (bytes). Layout: §3.2 */
export const RESPONSE_HEADER_SIZE = 11;

/** Size of an OpStats response body: 3 × uint64 = 24 bytes. */
export const STATS_BODY_SIZE = 24;

/** Size of an OpIncr payload (delta) and response (new value): 1 × int64 = 8 bytes. */
export const INCR_BODY_SIZE = 8;

// ── Opcodes ────────────────────────────────────────────────────────────────
// Source: main.go — const block below "Opcodes sent by the client"

export const Op = Object.freeze({
  /** Create or overwrite a key-value pair. ValLen = value bytes. */
  UPSERT : 0x01,
  /** Retrieve the value for a key. ValLen = 0 in request. */
  VIEW   : 0x02,
  /** Delete a key. ValLen = 0 in request. */
  DELETE : 0x03,
  /** Atomic int64 increment. ValLen = 8 (LE int64 delta). Response DataLen = 8. */
  INCR   : 0x04,
  /** Round-trip ping. ValLen = 0. Response DataLen = 0. */
  PING   : 0x05,
  /** Engine health metrics. ValLen = 0. Response DataLen = 24 (3 × uint64). */
  STATS  : 0x06,
});

// ── Status codes ───────────────────────────────────────────────────────────
// Source: main.go — const block below "Status codes returned by the server"

export const Status = Object.freeze({
  /** Operation completed successfully. */
  OK        : 0x00,
  /** Key does not exist in the engine index. */
  NOT_FOUND : 0x01,
  /** Operation failed — inspect BSEngine server logs for details. */
  ERROR     : 0x02,
});
