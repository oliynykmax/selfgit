import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { createInflate, deflateSync, inflateSync } from "node:zlib";
import { ByteInput } from "./byte-input";
import { deltaResultSize, applyDelta, walkDelta } from "./delta";
import {
  CorruptObject,
  hashObject,
  MAX_DELTA_DEPTH,
  type ObjectStore,
  type ObjectType,
  typeFromCode,
} from "./objects";

const OFS_DELTA = 6;
const REF_DELTA = 7;

/** Entries up to this inflated size are unpacked in memory with a synchronous inflate. */
const SMALL_ENTRY = 1 << 20;
/** How much compressed data is handed to a streaming inflate at once. */
const STREAM_STEP = 1 << 20;
/**
 * The most memory a single object, delta or delta base may take while a push is processed. A
 * Durable Object has 128 MB, and the push has to fit beside the runtime and the staged bundle.
 */
export const MAX_IN_MEMORY = 32 << 20;

const TOO_LARGE_HINT =
  "push without deltas for it, for example: git -c pack.window=0 push";

interface PendingDelta {
  offset: number;
  base: { offset: number } | { oid: string };
  delta: Buffer;
  /** The delta's zlib stream exactly as it appeared in the pack. */
  compressed: Buffer;
}

interface EntryHeader {
  code: number;
  size: number;
  length: number;
  base?: { distance: number } | { oid: string };
}

function parseEntryHeader(window: Buffer): EntryHeader {
  let at = 0;
  const next = () => {
    if (at >= window.length) throw new CorruptObject("pack truncated");
    return window[at++]!;
  };
  let byte = next();
  const code = (byte >> 4) & 7;
  let size = byte & 0x0f;
  let shift = 4;
  while (byte & 0x80) {
    byte = next();
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  let base: EntryHeader["base"];
  if (code === OFS_DELTA) {
    byte = next();
    let distance = byte & 0x7f;
    while (byte & 0x80) {
      byte = next();
      distance = (distance + 1) * 128 + (byte & 0x7f);
    }
    base = { distance };
  } else if (code === REF_DELTA) {
    if (at + 20 > window.length) throw new CorruptObject("pack truncated");
    base = { oid: window.toString("hex", at, at + 20) };
    at += 20;
  }
  return { code, size, length: at, base };
}

/**
 * Inflates one zlib stream at the start of `window` and reports where it ended. The window is
 * bounded by zlib's worst-case expansion so a large pack is not copied once per entry.
 */
function inflateAt(
  window: Buffer,
  size: number,
): { data: Buffer; next: number } {
  const bound = Math.min(window.length, size + (size >>> 9) + 64);
  for (const limit of bound < window.length
    ? [bound, window.length]
    : [bound]) {
    try {
      const { buffer, engine } = inflateSync(window.subarray(0, limit), {
        info: true,
        maxOutputLength: Math.max(size, 1),
      }) as unknown as {
        buffer: Buffer;
        engine: { bytesWritten: number };
      };
      return { data: buffer, next: engine.bytesWritten };
    } catch (error) {
      if (limit === window.length)
        throw new CorruptObject(`bad zlib data: ${(error as Error).message}`);
    }
  }
  throw new CorruptObject("unreachable");
}

async function readInMemory(
  input: ByteInput,
  size: number,
): Promise<{ data: Buffer; compressed: Buffer }> {
  await input.fill(size + (size >>> 9) + 64);
  const { data, next } = inflateAt(input.window, size);
  if (data.length !== size)
    throw new CorruptObject("object has the wrong size");
  const compressed = input.window.subarray(0, next);
  input.skip(next);
  return { data, compressed };
}

type Streamed =
  | { oid: string; inline: Buffer }
  | { oid: string; stored: { key: string; length: number } };

/**
 * Takes a large blob off the wire without ever holding it. The compressed bytes go straight to R2
 * as a multipart upload while an incremental inflate feeds the hash that names the object.
 */
async function streamBlob(
  input: ByteInput,
  store: ObjectStore,
  size: number,
): Promise<Streamed> {
  const sha = createHash("sha1").update(`blob ${size}\0`);
  const inflate = createInflate();
  const upload = store.startUpload();
  let inflated = 0;
  let failure: Error | undefined;
  inflate.on("data", (chunk: Buffer) => {
    inflated += chunk.length;
    if (inflated > size)
      failure ??= new CorruptObject("blob is larger than its header says");
    else sha.update(chunk);
  });
  // A failed write may never call back, so the error event has to end the wait too.
  const errored = new Promise<never>((_, reject) => {
    inflate.once("error", (error) =>
      reject(new CorruptObject(`bad zlib data: ${error.message}`)),
    );
  });
  errored.catch(() => {});
  const engine = inflate as unknown as { bytesWritten: number };
  try {
    for (;;) {
      // Request bodies arrive in chunks of about 4 KB, so gather a full step before each write.
      await input.fill(STREAM_STEP);
      const window = input.window;
      if (window.length === 0) throw new CorruptObject("pack truncated");
      const slice = window.subarray(0, Math.min(window.length, STREAM_STEP));
      const before = engine.bytesWritten;
      await Promise.race([
        errored,
        new Promise<void>((resolve, reject) =>
          inflate.write(slice, (error) => (error ? reject(error) : resolve())),
        ),
      ]);
      if (failure) throw failure;
      const used = engine.bytesWritten - before;
      if (used > 0) {
        await upload.write(slice.subarray(0, used));
        input.skip(used);
      }
      if (used < slice.length) break;
    }
    if (inflated !== size) throw new CorruptObject("object has the wrong size");
    const oid = sha.digest("hex");
    const done = await upload.finish();
    return "inline" in done
      ? { oid, inline: done.inline }
      : { oid, stored: done };
  } catch (error) {
    await upload.abort();
    throw error;
  } finally {
    inflate.destroy();
  }
}

class BaseCache {
  private readonly entries = new Map<
    string,
    { type: ObjectType; content: Buffer }
  >();
  private bytes = 0;
  constructor(
    private readonly store: ObjectStore,
    private readonly batch: ReturnType<ObjectStore["batch"]>,
    private readonly limit = MAX_IN_MEMORY,
  ) {}

  async get(oid: string): Promise<{ type: ObjectType; content: Buffer }> {
    const hit = this.entries.get(oid);
    if (hit) return hit;
    const size = this.batch.sizeOf(oid);
    if (size > MAX_IN_MEMORY)
      throw new CorruptObject(
        `delta base ${oid} is ${Math.round(size / 2 ** 20)} MB, too large to unpack in memory; ${TOO_LARGE_HINT}`,
      );
    if (this.batch.has(oid)) await this.batch.flush();
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
 * The pack is read as it arrives. Blobs over 1 MB stream into R2 without being held in memory, and
 * everything else is bounded by MAX_IN_MEMORY.
 */
export async function ingestPack(
  store: ObjectStore,
  source: Buffer | ReadableStream<Uint8Array> | ByteInput,
): Promise<Set<string>> {
  const input = source instanceof ByteInput ? source : new ByteInput(source);
  const added = new Set<string>();
  if (!(await input.fill(1))) return added;
  if (
    !(await input.fill(12)) ||
    input.window.toString("latin1", 0, 4) !== "PACK"
  )
    throw new CorruptObject("bad pack header");
  const version = input.window.readUInt32BE(4);
  if (version !== 2 && version !== 3)
    throw new CorruptObject(`unsupported pack version ${version}`);
  const count = input.window.readUInt32BE(8);
  input.startHashing();
  input.skip(12);

  const resolved = new Map<number, string>();
  const pending: PendingDelta[] = [];
  const batch = store.batch();
  const cache = new BaseCache(store, batch);
  const keep = async (
    oid: string,
    type: ObjectType,
    content: Buffer,
    zdata: Uint8Array,
  ) => {
    if (await batch.put(oid, type, content, zdata)) added.add(oid);
  };
  try {
    for (let i = 0; i < count; i++) {
      const offset = input.offset;
      await input.fill(64);
      const header = parseEntryHeader(input.window);
      input.skip(header.length);
      const type = typeFromCode(header.code);
      if (!type && !header.base)
        throw new CorruptObject(
          `invalid object type ${header.code} at ${offset}`,
        );

      if (type === "blob" && header.size >= SMALL_ENTRY) {
        const streamed = await streamBlob(input, store, header.size);
        const stored =
          "stored" in streamed
            ? await batch.putUploaded(
                streamed.oid,
                header.size,
                streamed.stored,
              )
            : await batch.putBlob(streamed.oid, header.size, streamed.inline);
        if (stored) added.add(streamed.oid);
        resolved.set(offset, streamed.oid);
        continue;
      }
      if (header.size > MAX_IN_MEMORY)
        throw new CorruptObject(
          `${type ?? "delta"} of ${Math.round(header.size / 2 ** 20)} MB is too large to unpack in memory; ${TOO_LARGE_HINT}`,
        );

      const { data, compressed } = await readInMemory(input, header.size);
      if (type) {
        const oid = hashObject(type, data);
        await keep(oid, type, data, compressed);
        cache.add(oid, { type, content: data });
        resolved.set(offset, oid);
      } else {
        const base = header.base!;
        pending.push({
          offset,
          base:
            "distance" in base
              ? { offset: offset - base.distance }
              : { oid: base.oid },
          delta: data,
          compressed,
        });
      }
    }

    const expected = input.finishHashing();
    if (!(await input.fill(20))) throw new CorruptObject("pack truncated");
    if (!input.window.subarray(0, 20).equals(expected))
      throw new CorruptObject("pack checksum mismatch");
    input.skip(20);
    if (await input.fill(1)) throw new CorruptObject("pack has trailing data");

    for (let progress = true; pending.length > 0 && progress;) {
      progress = false;
      for (let i = 0; i < pending.length;) {
        const entry = pending[i]!;
        const baseOid =
          "offset" in entry.base
            ? resolved.get(entry.base.offset)
            : batch.has(entry.base.oid) || (await store.has(entry.base.oid))
              ? entry.base.oid
              : undefined;
        if (!baseOid) {
          i++;
          continue;
        }
        const base = await cache.get(baseOid);
        const resultSize = deltaResultSize(entry.delta);
        const stored = {
          base: baseOid,
          zdata: entry.compressed,
          size: entry.delta.length,
        };
        let oid: string;
        if (base.type === "blob" && resultSize >= SMALL_ENTRY) {
          const sha = createHash("sha1").update(`blob ${resultSize}\0`);
          walkDelta(base.content, entry.delta, (slice) => sha.update(slice));
          oid = sha.digest("hex");
          if (await batch.putBlobDelta(oid, resultSize, stored)) added.add(oid);
        } else {
          if (resultSize > MAX_IN_MEMORY)
            throw new CorruptObject(
              `${base.type} of ${Math.round(resultSize / 2 ** 20)} MB is too large to unpack in memory; ${TOO_LARGE_HINT}`,
            );
          const content = applyDelta(base.content, entry.delta);
          oid = hashObject(base.type, content);
          if (batch.depthOf(baseOid) < MAX_DELTA_DEPTH) {
            if (await batch.putDelta(oid, base.type, content, stored))
              added.add(oid);
          } else await keep(oid, base.type, content, deflateSync(content));
          cache.add(oid, { type: base.type, content });
        }
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
  } catch (error) {
    await input.cancel();
    throw error;
  } finally {
    batch.discard();
  }
}
