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

/** The size of the object a delta produces, read from its header. */
export function deltaResultSize(delta: Buffer): number {
  const [, afterBase] = varint(delta, 0);
  return varint(delta, afterBase)[0];
}

/**
 * Replays a delta against its base and hands every produced slice to `emit` in order, without
 * building the result. Slices of the base are passed by reference.
 */
export function walkDelta(
  base: Buffer,
  delta: Buffer,
  emit: (slice: Buffer) => void,
): number {
  const [baseSize, afterBase] = varint(delta, 0);
  const [resultSize, start] = varint(delta, afterBase);
  if (baseSize !== base.length)
    throw new CorruptObject("delta base size mismatch");
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
      emit(base.subarray(offset, offset + size));
      written += size;
    } else if (op > 0) {
      if (pos + op > delta.length || written + op > resultSize)
        throw new CorruptObject("delta insert out of range");
      emit(delta.subarray(pos, pos + op));
      written += op;
      pos += op;
    } else {
      throw new CorruptObject("delta opcode 0");
    }
  }
  if (written !== resultSize)
    throw new CorruptObject("delta result size mismatch");
  return resultSize;
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  if (varint(delta, 0)[0] !== base.length)
    throw new CorruptObject("delta base size mismatch");
  const out = Buffer.allocUnsafe(deltaResultSize(delta));
  let written = 0;
  walkDelta(base, delta, (slice) => {
    slice.copy(out, written);
    written += slice.length;
  });
  return out;
}
