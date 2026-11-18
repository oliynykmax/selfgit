import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { CorruptObject, type ObjectStore, TYPE_CODE } from "./objects";

const REF_DELTA = 7;
const WINDOW_BYTES = 8 << 20;

function entryHeader(code: number, size: number): Buffer {
  const bytes: number[] = [];
  let byte = (code << 4) | (size & 0x0f);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    bytes.push(byte | 0x80);
    byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(byte);
  return Buffer.from(bytes);
}

/** Objects whose stored payload is at least this large are copied from R2 to the client as a stream. */
const STREAM_OBJECT_BYTES = 4 << 20;

/**
 * Yields a version 2 pack, copying stored zlib data without recompressing. Objects stored as
 * deltas go out as deltas, so their bases are added to the pack when the caller did not list them.
 */
export async function* writePack(
  store: ObjectStore,
  requested: string[],
): AsyncGenerator<Buffer> {
  const oids = [...requested];
  const wanted = new Set(oids);
  for (let i = 0; i < oids.length; i++) {
    const base = store.info(oids[i]!)?.base;
    if (base && !wanted.has(base)) {
      wanted.add(base);
      oids.push(base);
    }
  }
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
  const streamed = (oid: string) =>
    (store.payloadLength(oid) ?? 0) >= STREAM_OBJECT_BYTES &&
    !store.info(oid)?.base;
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
  const load = (window: string[]) =>
    store.zdataBatch(window.filter((oid) => !streamed(oid)));
  let loading = windows[0] ? load(windows[0]) : undefined;
  for (let w = 0; w < windows.length; w++) {
    const data = await loading!;
    loading = windows[w + 1] ? load(windows[w + 1]!) : undefined;
    loading?.catch(() => {});
    for (const oid of windows[w]!) {
      const info = store.info(oid);
      if (!info) throw new CorruptObject(`missing object ${oid}`);
      if (info.base) {
        yield emit(entryHeader(REF_DELTA, info.deltaSize));
        yield emit(Buffer.from(info.base, "hex"));
        yield emit(data.get(oid)!);
      } else if (streamed(oid)) {
        yield emit(entryHeader(TYPE_CODE[info.type], info.size));
        for await (const chunk of store.streamPayload(oid))
          yield emit(
            Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength),
          );
      } else {
        yield emit(entryHeader(TYPE_CODE[info.type], info.size));
        yield emit(data.get(oid)!);
      }
    }
  }
  yield hash.digest();
}
