import { Buffer } from "node:buffer";

export const FLUSH = Buffer.from("0000");

export function pkt(data: string | Uint8Array): Buffer {
  const body = typeof data === "string" ? Buffer.from(data) : data;
  const head = Buffer.from((body.length + 4).toString(16).padStart(4, "0"));
  return Buffer.concat([head, body]);
}

export class ProtocolError extends Error {}

export class PktReader {
  pos = 0;
  constructor(readonly buf: Buffer) {}

  get done(): boolean {
    return this.pos >= this.buf.length;
  }

  /** Returns the payload, `null` for a flush packet, or throws on malformed input. */
  read(): Buffer | null {
    if (this.pos + 4 > this.buf.length)
      throw new ProtocolError("truncated pkt-line");
    const len = Number.parseInt(
      this.buf.toString("latin1", this.pos, this.pos + 4),
      16,
    );
    if (
      Number.isNaN(len) ||
      (len > 0 && len < 4) ||
      this.pos + Math.max(len, 4) > this.buf.length
    ) {
      throw new ProtocolError("malformed pkt-line");
    }
    this.pos += 4;
    if (len === 0) return null;
    const payload = this.buf.subarray(this.pos, this.pos + len - 4);
    this.pos += len - 4;
    return payload;
  }

  /** Reads a text line with its trailing newline removed. */
  readLine(): string | null {
    const payload = this.read();
    if (payload === null) return null;
    const text = payload.toString("latin1");
    return text.endsWith("\n") ? text.slice(0, -1) : text;
  }

  rest(): Buffer {
    return this.buf.subarray(this.pos);
  }
}

const SIDEBAND_MAX = { "side-band-64k": 65515, "side-band": 995 } as const;
export type Sideband = keyof typeof SIDEBAND_MAX | null;

export function* sideband(
  band: 1 | 2 | 3,
  data: Uint8Array,
  mode: Exclude<Sideband, null>,
): Generator<Buffer> {
  const max = SIDEBAND_MAX[mode];
  for (let off = 0; off < data.length; off += max) {
    yield pkt(
      Buffer.concat([Buffer.from([band]), data.subarray(off, off + max)]),
    );
  }
}
