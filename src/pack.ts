import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import {
  CorruptObject,
  hashObject,
  type ObjectStore,
  type ObjectType,
  TYPE_CODE,
  typeFromCode,
} from "./objects";

const OFS_DELTA = 6;
const REF_DELTA = 7;
const WINDOW_BYTES = 8 << 20;

interface PendingDelta {
  offset: number;
  base: { offset: number } | { oid: string };
  delta: Buffer;
}

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

/**
 * Inflates one zlib stream starting at `pos` and reports where it ended. The window is bounded by
 * zlib's worst-case expansion so a large pack is not copied once per entry.
 */
function inflateAt(
  pack: Buffer,
  pos: number,
  end: number,
  size: number,
): { data: Buffer; next: number } {
  const bound = Math.min(end, pos + size + (size >>> 9) + 64);
  for (const limit of bound < end ? [bound, end] : [end]) {
    try {
      const { buffer, engine } = inflateSync(pack.subarray(pos, limit), {
        info: true,
      }) as unknown as {
        buffer: Buffer;
        engine: { bytesWritten: number };
      };
      return { data: buffer, next: pos + engine.bytesWritten };
    } catch (error) {
      if (limit === end)
        throw new CorruptObject(
          `bad zlib data at ${pos}: ${(error as Error).message}`,
        );
    }
  }
  throw new CorruptObject("unreachable");
}

class BaseCache {
  private readonly entries = new Map<
    string,
    { type: ObjectType; content: Buffer }
  >();
  private bytes = 0;
  constructor(
    private readonly store: ObjectStore,
    private readonly beforeStoreRead: () => Promise<void>,
    private readonly limit = 32 << 20,
  ) {}

  async get(oid: string): Promise<{ type: ObjectType; content: Buffer }> {
    const hit = this.entries.get(oid);
    if (hit) return hit;
    await this.beforeStoreRead();
    const object = await this.store.read(oid);
    if (!object) throw new CorruptObject(`missing delta base ${oid}`);
    this.add(oid, object);
    return object;
  }

  add(oid: string, object: { type: ObjectType; content: Buffer }): void {
    this.entries.set(oid, object);
    this.bytes += object.content.length;
    for (const [key, value] of this.entries) {
      if (this.bytes <= this.limit) break;
      this.entries.delete(key);
      this.bytes -= value.content.length;
    }
  }
}

/**
 * Stores every object in a received pack, resolving OFS_DELTA and REF_DELTA entries (including thin
 * packs whose bases already live in the store). Returns the ids of objects the store did not have.
 */
export async function ingestPack(
  store: ObjectStore,
  pack: Buffer,
): Promise<Set<string>> {
  const added = new Set<string>();
  if (pack.length === 0) return added;
  if (pack.length < 32 || pack.toString("latin1", 0, 4) !== "PACK")
    throw new CorruptObject("bad pack header");
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3)
    throw new CorruptObject(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const end = pack.length - 20;
  const checksum = createHash("sha1").update(pack.subarray(0, end)).digest();
  if (!checksum.equals(pack.subarray(end)))
    throw new CorruptObject("pack checksum mismatch");

  const resolved = new Map<number, string>();
  const pending: PendingDelta[] = [];
  const batch = store.batch();
  const cache = new BaseCache(store, batch.flush);
  const keep = async (
    oid: string,
    type: ObjectType,
    content: Buffer,
    zdata: Uint8Array,
  ) => {
    if (await batch.put(oid, type, content, zdata)) added.add(oid);
  };
  try {
    let pos = 12;
    for (let i = 0; i < count; i++) {
      const offset = pos;
      if (pos >= end) throw new CorruptObject("pack truncated");
      let byte = pack[pos++]!;
      const code = (byte >> 4) & 7;
      let size = byte & 0x0f;
      let shift = 4;
      while (byte & 0x80) {
        byte = pack[pos++]!;
        size += (byte & 0x7f) * 2 ** shift;
        shift += 7;
      }
      let base: PendingDelta["base"] | undefined;
      if (code === OFS_DELTA) {
        byte = pack[pos++]!;
        let distance = byte & 0x7f;
        while (byte & 0x80) {
          byte = pack[pos++]!;
          distance = (distance + 1) * 128 + (byte & 0x7f);
        }
        base = { offset: offset - distance };
      } else if (code === REF_DELTA) {
        base = { oid: pack.toString("hex", pos, pos + 20) };
        pos += 20;
      }
      const { data, next } = inflateAt(pack, pos, end, size);
      if (data.length !== size)
        throw new CorruptObject(`object at ${offset} has wrong size`);
      const type = typeFromCode(code);
      if (type) {
        const oid = hashObject(type, data);
        await keep(oid, type, data, pack.subarray(pos, next));
        resolved.set(offset, oid);
      } else if (base) {
        pending.push({ offset, base, delta: data });
      } else {
        throw new CorruptObject(`invalid object type ${code} at ${offset}`);
      }
      pos = next;
    }
    if (pos !== end) throw new CorruptObject("pack has trailing data");

    await batch.flush();
    for (let progress = true; pending.length > 0 && progress;) {
      progress = false;
      for (let i = 0; i < pending.length;) {
        const entry = pending[i]!;
        const baseOid =
          "offset" in entry.base
            ? resolved.get(entry.base.offset)
            : (await store.has(entry.base.oid))
              ? entry.base.oid
              : undefined;
        if (!baseOid) {
          i++;
          continue;
        }
        const base = await cache.get(baseOid);
        const content = applyDelta(base.content, entry.delta);
        const oid = hashObject(base.type, content);
        await keep(oid, base.type, content, deflateSync(content));
        cache.add(oid, { type: base.type, content });
        resolved.set(entry.offset, oid);
        pending[i] = pending[pending.length - 1]!;
        pending.pop();
        progress = true;
      }
    }
    if (pending.length > 0)
      throw new CorruptObject(`${pending.length} unresolved deltas`);
    await batch.flush();
    return added;
  } finally {
    batch.discard();
  }
}

function entryHeader(type: ObjectType, size: number): Buffer {
  const bytes: number[] = [];
  let byte = (TYPE_CODE[type] << 4) | (size & 0x0f);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    bytes.push(byte | 0x80);
    byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(byte);
  return Buffer.from(bytes);
}

/** Yields a version 2 pack of undeltified objects, copying stored zlib data without recompressing. */
export async function* writePack(
  store: ObjectStore,
  oids: string[],
): AsyncGenerator<Buffer> {
  const hash = createHash("sha1");
  const emit = (chunk: Buffer) => {
    hash.update(chunk);
    return chunk;
  };
  const header = Buffer.alloc(12);
  header.write("PACK", 0, "latin1");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  yield emit(header);
  // Objects are read a window at a time, and the next window loads while this one is written.
  const windows: string[][] = [];
  for (let start = 0, bytes = 0, i = 0; i <= oids.length; i++) {
    const size = i < oids.length ? (store.info(oids[i]!)?.size ?? 0) : 0;
    if (i === oids.length || (i > start && bytes + size > WINDOW_BYTES)) {
      if (i > start) windows.push(oids.slice(start, i));
      start = i;
      bytes = 0;
    }
    bytes += size;
  }
  let loading = windows[0] ? store.zdataBatch(windows[0]) : undefined;
  for (let w = 0; w < windows.length; w++) {
    const data = await loading!;
    loading = windows[w + 1] ? store.zdataBatch(windows[w + 1]!) : undefined;
    loading?.catch(() => {});
    for (const oid of windows[w]!) {
      const info = store.info(oid);
      if (!info) throw new CorruptObject(`missing object ${oid}`);
      yield emit(entryHeader(info.type, info.size));
      yield emit(data.get(oid)!);
    }
  }
  yield hash.digest();
}
