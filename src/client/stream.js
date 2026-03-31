/**
 * ExactReader — Buffered Exact-Byte Reader for WHATWG ReadableStream
 *
 * Cloudflare Workers TCP sockets expose their data as a ReadableStream<Uint8Array>.
 * The underlying chunks are arbitrarily sized and may not align with protocol
 * boundaries. ExactReader wraps the stream reader and provides `readExact(n)`,
 * which accumulates chunks until exactly n bytes are available, then returns
 * those bytes and buffers any remaining excess for the next call.
 *
 * This is the correct pattern for any binary protocol over a streaming transport.
 */
export class ExactReader {
  /**
   * @param {ReadableStreamDefaultReader<Uint8Array>} reader
   *   Obtained from `socket.readable.getReader()`.
   */
  constructor(reader) {
    this._reader = reader;
    /** @type {Uint8Array} Internal byte accumulator. */
    this._buf    = new Uint8Array(0);
  }

  /**
   * Reads exactly `n` bytes from the stream, waiting for more chunks as needed.
   *
   * @param {number} n — number of bytes to read
   * @returns {Promise<Uint8Array>} A new Uint8Array of exactly n bytes.
   * @throws {Error} If the stream closes before n bytes are available.
   */
  async readExact(n) {
    while (this._buf.length < n) {
      const { done, value } = await this._reader.read();
      if (done) {
        throw new Error(
          `BSEngine: stream closed prematurely — needed ${n} bytes, had ${this._buf.length}`
        );
      }
      this._buf = ExactReader._concat(this._buf, value);
    }

    const result  = this._buf.slice(0, n);
    this._buf = this._buf.slice(n);
    return result;
  }

  /**
   * Concatenates two Uint8Arrays into a new Uint8Array.
   * @param {Uint8Array} a
   * @param {Uint8Array} b
   * @returns {Uint8Array}
   */
  static _concat(a, b) {
    const merged = new Uint8Array(a.length + b.length);
    merged.set(a, 0);
    merged.set(b, a.length);
    return merged;
  }
}
