import { Buffer } from "node:buffer";
import { createHash, type Hash } from "node:crypto";
import { ProtocolError } from "./pktline";

/**
 * A request body read as it arrives. Callers look at `window`, ask for more with `fill`, and then
 * `skip` what they used. Memory use is whatever the caller asks to have buffered, never the body.
 */
export class ByteInput {
  private buf: Buffer = Buffer.alloc(0);
  private pos = 0;
  private ended = false;
  private hash: Hash | null = null;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array> | null;
  /** Bytes consumed since `startHashing`, which is how pack entries address each other. */
  offset = 0;

  constructor(source: Buffer | ReadableStream<Uint8Array>) {
    if (Buffer.isBuffer(source)) {
      this.buf = source;
      this.ended = true;
      this.reader = null;
    } else {
      this.reader = source.getReader();
    }
  }

  get window(): Buffer {
    return this.buf.subarray(this.pos);
  }

  /** Buffers at least `n` bytes unless the body ends first, and reports whether it did. */
  async fill(n: number): Promise<boolean> {
    if (this.window.length >= n || this.ended) return this.window.length >= n;
    const chunks: Buffer[] = [];
    let have = this.window.length;
    if (have > 0) chunks.push(this.window);
    while (have < n) {
      const { done, value } = await this.reader!.read();
      if (done) {
        this.ended = true;
        break;
      }
      if (value.length === 0) continue;
      chunks.push(
        Buffer.from(value.buffer, value.byteOffset, value.byteLength),
      );
      have += value.length;
    }
    this.buf = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks);
    this.pos = 0;
    return have >= n;
  }

  /** Consumes bytes, feeding them to the pack checksum when one is running. */
  skip(n: number): void {
    this.hash?.update(this.buf.subarray(this.pos, this.pos + n));
    this.pos += n;
    this.offset += n;
  }

  startHashing(): void {
    this.hash = createHash("sha1");
    this.offset = 0;
  }

  /** The checksum of everything consumed since `startHashing`, which ends the run. */
  finishHashing(): Buffer {
    const digest = this.hash!.digest();
    this.hash = null;
    return digest;
  }

  /** Returns the payload of one pkt-line, or null for a flush packet. */
  async readPkt(): Promise<Buffer | null> {
    if (!(await this.fill(4))) throw new ProtocolError("truncated pkt-line");
    const len = Number.parseInt(this.window.toString("latin1", 0, 4), 16);
    if (Number.isNaN(len) || (len > 0 && len < 4))
      throw new ProtocolError("malformed pkt-line");
    if (len === 0) {
      this.skip(4);
      return null;
    }
    if (!(await this.fill(len))) throw new ProtocolError("malformed pkt-line");
    const payload = Buffer.from(this.window.subarray(4, len));
    this.skip(len);
    return payload;
  }

  /** Stops reading the body. */
  async cancel(): Promise<void> {
    await this.reader?.cancel().catch(() => {});
  }
}
