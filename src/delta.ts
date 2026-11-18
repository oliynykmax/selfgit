import { Buffer } from "node:buffer";
import { CorruptObject } from "./objects";

function varint(buf: Buffer, start: number): [value: number, next: number] {
  let value = 0;
  let shift = 0;
  let pos = start;
  let byte: number;
  do {
    if (pos >= buf.length) throw new CorruptObject("truncated delta header");
    byte = buf[pos++]!;
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  } while (byte & 0x80);
  return [value, pos];
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const [baseSize, afterBase] = varint(delta, 0);
  const [resultSize, start] = varint(delta, afterBase);
  if (baseSize !== base.length)
    throw new CorruptObject("delta base size mismatch");
  const out = Buffer.allocUnsafe(resultSize);
  let written = 0;
  let pos = start;
  while (pos < delta.length) {
    const op = delta[pos++]!;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit++)
        if (op & (1 << bit)) offset += delta[pos++]! * 2 ** (8 * bit);
      for (let bit = 0; bit < 3; bit++)
        if (op & (0x10 << bit)) size += delta[pos++]! << (8 * bit);
      if (size === 0) size = 0x10000;
      if (offset + size > base.length || written + size > resultSize)
        throw new CorruptObject("delta copy out of range");
      base.copy(out, written, offset, offset + size);
      written += size;
    } else if (op > 0) {
      if (pos + op > delta.length || written + op > resultSize)
        throw new CorruptObject("delta insert out of range");
      delta.copy(out, written, pos, pos + op);
      written += op;
      pos += op;
    } else {
      throw new CorruptObject("delta opcode 0");
    }
  }
  if (written !== resultSize)
    throw new CorruptObject("delta result size mismatch");
  return out;
}
