/**
 * Input Validation Utilities
 *
 * HTTP-layer validation that mirrors the TCP-layer validation in BSEngine's
 * handleConnection (main.go). Catching bad input here avoids opening a TCP
 * connection only to be rejected by the engine.
 */

import { MAX_KEY_SIZE, MAX_VALUE_SIZE } from '../config.js';

const _enc = new TextEncoder();

/**
 * Validates a key string against BSEngine constraints.
 *
 * Rules (matching main.go §handleConnection):
 *   - Must be non-empty
 *   - UTF-8 encoding must be 1–64 bytes
 *
 * @param {string} key
 * @returns {string|null} Error message string, or null if the key is valid.
 */
export function validateKey(key) {
  if (typeof key !== 'string' || key.length === 0) {
    return 'Key must be a non-empty string';
  }
  const encoded = _enc.encode(key);
  if (encoded.length > MAX_KEY_SIZE) {
    return `Key is ${encoded.length} bytes — exceeds BSEngine limit of ${MAX_KEY_SIZE} bytes`;
  }
  return null;
}

/**
 * Validates value size against BSEngine's MaxValueSize limit.
 *
 * @param {number} byteLength — size of the value in bytes
 * @returns {string|null} Error message string, or null if the size is valid.
 */
export function validateValueSize(byteLength) {
  if (byteLength > MAX_VALUE_SIZE) {
    const mb = (MAX_VALUE_SIZE / (1024 * 1024)).toFixed(0);
    return `Value is ${byteLength} bytes — exceeds BSEngine limit of ${mb} MiB`;
  }
  return null;
}

/**
 * Encodes a key string to a Uint8Array.
 * Always call after validateKey to ensure the result is within bounds.
 *
 * @param {string} key
 * @returns {Uint8Array}
 */
export function encodeKey(key) {
  return _enc.encode(key);
}
