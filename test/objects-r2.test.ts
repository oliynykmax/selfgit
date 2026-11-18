import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { deflateSync } from "node:zlib";
import { ObjectStore, hashObject, deleteRepoObjects } from "../src/objects";

function setup() {
  const db = new Database(":memory:");
  const sql = {
    exec(query: string, ...args: unknown[]) {
      const rows = db.query(query).all(...args);
      return {
        toArray: () => rows,
        one: () => rows[0],
        [Symbol.iterator]: () => rows[Symbol.iterator](),
      };
    },
  } as unknown as SqlStorage;
  const data = new Map<string, Uint8Array>();
  const calls = { get: 0, put: 0, head: 0 };
  let fail = false;
  const bucket = {
    async put(key: string, value: Uint8Array) {
      calls.put++;
      if (fail) throw new Error("R2 unavailable");
      data.set(key, Uint8Array.from(value));
    },
    async get(
      key: string,
      options?: { range?: { offset: number; length: number } },
    ) {
      calls.get++;
      const value = data.get(key);
      if (!value) return null;
      const range = options?.range;
      const part = range
        ? value.slice(range.offset, range.offset + range.length)
        : value;
      return { arrayBuffer: async () => Uint8Array.from(part).buffer };
    },
    async head(key: string) {
      calls.head++;
      return data.has(key) ? {} : null;
    },
    async delete(keys: string[]) {
      for (const key of keys) data.delete(key);
    },
  } as unknown as R2Bucket;
  return {
    db,
    data,
    calls,
    store: new ObjectStore(sql, bucket, "repo-id"),
    setFailure(value: boolean) {
      fail = value;
    },
  };
}

test("legacy payload migrates only after verified R2 write and retains SQLite data", async () => {
  const { db, data, store, setFailure } = setup();
  const content = Buffer.from("legacy data");
  const oid = hashObject("blob", content);
  const compressed = deflateSync(content);
  db.query(
    "INSERT INTO objects (oid, type, size, links, zdata) VALUES (?, 3, ?, '', ?)",
  ).run(oid, content.length, compressed);
  setFailure(true);
  await expect(store.read(oid)).rejects.toThrow("R2 unavailable");
  expect(db.query("SELECT in_r2 FROM objects WHERE oid = ?").get(oid)).toEqual({
    in_r2: 0,
  });
  setFailure(false);
  expect((await store.read(oid))?.content).toEqual(content);
  expect(data.has(`repo-id/${oid}`)).toBe(true);
  expect(db.query("SELECT in_r2 FROM objects WHERE oid = ?").get(oid)).toEqual({
    in_r2: 1,
  });
  expect(
    db.query("SELECT zdata FROM objects WHERE oid = ?").get(oid),
  ).toBeTruthy();
  expect((await store.read(oid))?.content).toEqual(content);
});

test("failed R2 upload cannot publish object metadata", async () => {
  const { db, store, setFailure } = setup();
  const content = Buffer.from("new data");
  const oid = hashObject("blob", content);
  setFailure(true);
  const failed = store.batch();
  await failed.put(oid, "blob", content, deflateSync(content));
  await expect(failed.flush()).rejects.toThrow("R2 unavailable");
  expect(db.query("SELECT oid FROM objects WHERE oid = ?").get(oid)).toBeNull();
  setFailure(false);
  const retry = store.batch();
  expect(await retry.put(oid, "blob", content, deflateSync(content))).toBe(
    true,
  );
  await retry.flush();
  expect(
    db.query("SELECT zdata, in_r2 FROM objects WHERE oid = ?").get(oid),
  ).toEqual({ zdata: null, in_r2: 1 });
  expect((await store.read(oid))?.content).toEqual(content);
});

function blobs(count: number) {
  return Array.from({ length: count }, (_, i) => {
    const content = Buffer.from(`object ${i} ${"x".repeat(i)}`);
    return {
      content,
      oid: hashObject("blob", content),
      z: deflateSync(content),
    };
  });
}

test("one push becomes one R2 bundle and a clone reads it with one request", async () => {
  const { data, calls, store } = setup();
  const objects = blobs(50);
  const batch = store.batch();
  for (const { oid, content, z } of objects)
    await batch.put(oid, "blob", content, z);
  await batch.flush();
  expect(calls.put).toBe(1);
  expect([...data.keys()].every((key) => key.startsWith("repo-id/pack-"))).toBe(
    true,
  );
  calls.get = 0;
  const read = await store.zdataBatch(objects.map((object) => object.oid));
  expect(calls.get).toBe(1);
  for (const { oid, z } of objects) expect(read.get(oid)).toEqual(z);
  expect((await store.read(objects[7]!.oid))?.content).toEqual(
    objects[7]!.content,
  );
});

test("an object already stored is not written again, and a lost bundle is detected and repaired", async () => {
  const { data, calls, store } = setup();
  const [object] = blobs(1);
  const first = store.batch();
  await first.put(object!.oid, "blob", object!.content, object!.z);
  await first.flush();
  const again = store.batch();
  expect(await again.put(object!.oid, "blob", object!.content, object!.z)).toBe(
    false,
  );
  await again.flush();
  expect(calls.put).toBe(1);
  data.clear();
  store.clearReadCache();
  expect(await store.has(object!.oid)).toBe(false);
  const repair = store.batch();
  expect(
    await repair.put(object!.oid, "blob", object!.content, object!.z),
  ).toBe(true);
  await repair.flush();
  expect(await store.has(object!.oid)).toBe(true);
  expect((await store.read(object!.oid))?.content).toEqual(object!.content);
});

test("bundle existence is checked once per bundle however many objects ask", async () => {
  const { calls, store } = setup();
  const objects = blobs(20);
  const batch = store.batch();
  for (const { oid, content, z } of objects)
    await batch.put(oid, "blob", content, z);
  await batch.flush();
  store.clearReadCache();
  calls.head = 0;
  for (const { oid } of objects) expect(await store.has(oid)).toBe(true);
  expect(calls.head).toBe(1);
});

test("repack moves per-object R2 data into bundles without losing or duplicating objects", async () => {
  const { db, data, calls, store } = setup();
  const objects = blobs(30);
  for (const { oid, content, z } of objects) {
    db.query(
      "INSERT INTO objects (oid, type, size, links, zdata, in_r2) VALUES (?, 3, ?, '', NULL, 1)",
    ).run(oid, content.length);
    data.set(`repo-id/${oid}`, z);
  }
  const result = await store.repack();
  expect(result).toEqual({ moved: 30, remaining: 0 });
  expect([...data.keys()].filter((key) => !key.includes("/pack-"))).toEqual([]);
  expect(data.size).toBe(1);
  calls.get = 0;
  const read = await store.zdataBatch(objects.map((object) => object.oid));
  expect(calls.get).toBe(1);
  for (const { oid, z } of objects) expect(read.get(oid)).toEqual(z);
  expect(await store.repack()).toEqual({ moved: 0, remaining: 0 });
});

test("repack keeps the old objects when the bundle cannot be written", async () => {
  const { db, data, store, setFailure } = setup();
  const [object] = blobs(1);
  db.query(
    "INSERT INTO objects (oid, type, size, links, zdata, in_r2) VALUES (?, 3, ?, '', NULL, 1)",
  ).run(object!.oid, object!.content.length);
  data.set(`repo-id/${object!.oid}`, object!.z);
  setFailure(true);
  await expect(store.repack()).rejects.toThrow("R2 unavailable");
  expect(data.has(`repo-id/${object!.oid}`)).toBe(true);
  expect(
    db.query("SELECT bundle FROM objects WHERE oid = ?").get(object!.oid),
  ).toEqual({ bundle: null });
  setFailure(false);
  expect((await store.read(object!.oid))?.content).toEqual(object!.content);
});

test("receive-pack leaves refs unchanged after an upload failure and succeeds on retry", async () => {
  const { createHash } = await import("node:crypto");
  const { receivePack } = await import("../src/protocol");
  const { db, store, setFailure } = setup();
  const content = Buffer.from("retry content");
  const oid = hashObject("blob", content);
  const header = Buffer.alloc(12);
  header.write("PACK");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(1, 8);
  const entry = Buffer.from([
    0xb0 | (content.length & 15),
    content.length >> 4,
  ]);
  const pack = Buffer.concat([header, entry, deflateSync(content)]);
  const packWithHash = Buffer.concat([
    pack,
    createHash("sha1").update(pack).digest(),
  ]);
  const line = Buffer.from(
    `${"0".repeat(40)} ${oid} refs/heads/main\0report-status\n`,
  );
  const body = Buffer.concat([
    Buffer.from((line.length + 4).toString(16).padStart(4, "0")),
    line,
    Buffer.from("0000"),
    packWithHash,
  ]);
  const transaction = (fn: () => void) => db.transaction(fn)();
  setFailure(true);
  await expect(receivePack(store, transaction, body)).rejects.toThrow(
    "R2 unavailable",
  );
  expect(store.refs().size).toBe(0);
  setFailure(false);
  expect((await receivePack(store, transaction, body)).toString()).toContain(
    "ok refs/heads/main",
  );
  expect(store.refs().get("refs/heads/main")).toBe(oid);
});

test("repository cleanup retries paginated failures without touching other prefixes", async () => {
  const keys = new Set(["repo/a", "repo/b", "repo/c", "repo-other/a"]);
  let fail = true;
  const bucket = {
    async list({ prefix, cursor }: { prefix: string; cursor?: string }) {
      const matches = [...keys]
        .filter((key) => key.startsWith(prefix) && (!cursor || key > cursor))
        .sort();
      const objects = matches.slice(0, 1).map((key) => ({ key }));
      return matches.length > 1
        ? { objects, truncated: true, cursor: objects[0]!.key }
        : { objects, truncated: false };
    },
    async delete(batch: string[]) {
      if (batch[0] === "repo/b" && fail) {
        fail = false;
        throw new Error("unavailable");
      }
      for (const key of batch) keys.delete(key);
    },
  } as unknown as R2Bucket;
  await expect(deleteRepoObjects(bucket, "repo")).rejects.toThrow(
    "unavailable",
  );
  await deleteRepoObjects(bucket, "repo");
  expect([...keys]).toEqual(["repo-other/a"]);
});

test("R2 audit reports verified, missing and corrupt objects without changing SQL", async () => {
  const { db, data, store } = setup();
  const contents = ["valid", "missing", "corrupt"].map((value) =>
    Buffer.from(value),
  );
  const ids = contents.map((content) => hashObject("blob", content));
  for (let i = 0; i < ids.length; i++) {
    db.query(
      "INSERT INTO objects (oid, type, size, links, in_r2) VALUES (?, 3, ?, '', 1)",
    ).run(ids[i]!, contents[i]!.length);
  }
  data.set(`repo-id/${ids[0]}`, deflateSync(contents[0]!));
  data.set(`repo-id/${ids[2]}`, deflateSync(Buffer.from("wrong")));
  const audit = await store.auditR2("");
  expect(
    Object.fromEntries(audit.results.map((item) => [item.oid, item.status])),
  ).toEqual({ [ids[0]!]: "valid", [ids[1]!]: "missing", [ids[2]!]: "corrupt" });
  expect(db.query("SELECT count(*) AS count FROM objects").get()).toEqual({
    count: 3,
  });
});

test("a pack of deltas against stored bases is written as one bundle", async () => {
  const { ingestPack } = await import("../src/pack");
  const { createHash } = await import("node:crypto");
  const { calls, store } = setup();
  const bases = blobs(6);
  const seed = store.batch();
  for (const { oid, content, z } of bases)
    await seed.put(oid, "blob", content, z);
  await seed.flush();
  calls.put = 0;
  const entries = bases.map(({ oid, content }, i) => {
    const text = Buffer.from(`delta target ${i} built from ${content.length}`);
    const delta = Buffer.concat([
      Buffer.from([content.length, text.length, text.length]),
      text,
    ]);
    const header = Buffer.from([0xf0 | (delta.length & 15), delta.length >> 4]);
    return Buffer.concat([header, Buffer.from(oid, "hex"), deflateSync(delta)]);
  });
  const head = Buffer.alloc(12);
  head.write("PACK");
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(entries.length, 8);
  const body = Buffer.concat([head, ...entries]);
  const pack = Buffer.concat([body, createHash("sha1").update(body).digest()]);
  const added = await ingestPack(store, pack);
  expect(added.size).toBe(bases.length);
  expect(calls.put).toBe(1);
});

function packEntry(code: number, size: number, extra: Buffer, z: Buffer) {
  const bytes: number[] = [];
  let byte = (code << 4) | (size & 15);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    bytes.push(byte | 0x80);
    byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(byte);
  return Buffer.concat([Buffer.from(bytes), extra, z]);
}

function varint(value: number) {
  const bytes: number[] = [];
  do {
    bytes.push((value & 0x7f) | (value > 0x7f ? 0x80 : 0));
    value = Math.floor(value / 128);
  } while (value > 0);
  return Buffer.from(bytes);
}

/** A delta that copies all of base and appends `extra`. */
function appendDelta(base: Buffer, extra: string) {
  const tail = Buffer.from(extra);
  return Buffer.concat([
    varint(base.length),
    varint(base.length + tail.length),
    Buffer.from([0x80 | 0x10 | 0x20, base.length & 0xff, base.length >> 8]),
    Buffer.from([tail.length]),
    tail,
  ]);
}

async function packOf(entries: Buffer[]) {
  const { createHash } = await import("node:crypto");
  const head = Buffer.alloc(12);
  head.write("PACK");
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(entries.length, 8);
  const body = Buffer.concat([head, ...entries]);
  return Buffer.concat([body, createHash("sha1").update(body).digest()]);
}

async function collect(stream: AsyncGenerator<Buffer>) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function indexPack(pack: Buffer) {
  const dir = require("node:fs").mkdtempSync(
    require("node:path").join(require("node:os").tmpdir(), "selfgit-pack-"),
  );
  Bun.spawnSync(["git", "init", "-q", dir]);
  return Bun.spawnSync(["git", "-C", dir, "index-pack", "--stdin"], {
    stdin: pack,
  });
}

test("deltas are stored as sent, shipped as deltas with their base, and read back whole", async () => {
  const { ingestPack, writePack } = await import("../src/pack");
  const { db, store } = setup();
  const base = Buffer.from(
    Array.from({ length: 300 }, (_, i) => `line ${i}\n`).join(""),
  );
  const baseOid = hashObject("blob", base);
  const seed = store.batch();
  await seed.put(baseOid, "blob", base, deflateSync(base));
  await seed.flush();

  const delta = appendDelta(base, "added\n");
  const target = Buffer.concat([base, Buffer.from("added\n")]);
  const targetOid = hashObject("blob", target);
  const pack = await packOf([
    packEntry(7, delta.length, Buffer.from(baseOid, "hex"), deflateSync(delta)),
  ]);
  expect([...(await ingestPack(store, pack))]).toEqual([targetOid]);
  expect(
    db
      .query("SELECT base, depth, dsize FROM objects WHERE oid = ?")
      .get(targetOid),
  ).toEqual({ base: baseOid, depth: 1, dsize: delta.length });
  expect((await store.read(targetOid))?.content).toEqual(target);

  const whole = await collect(writePack(store, [baseOid, targetOid]));
  const reordered = await collect(writePack(store, [targetOid, baseOid]));
  const full = deflateSync(base).length + deflateSync(target).length;
  expect(whole.length).toBeLessThan(full * 0.7);
  for (const pack of [whole, reordered]) {
    const result = indexPack(pack);
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  }

  const alone = await collect(writePack(store, [targetOid]));
  expect(alone.length).toBeGreaterThan(deflateSync(target).length);
  expect(indexPack(alone).exitCode).toBe(0);
});

test("delta chains stop at the depth limit and the next version is stored whole", async () => {
  const { ingestPack } = await import("../src/pack");
  const { MAX_DELTA_DEPTH } = await import("../src/objects");
  const { db, store } = setup();
  let content = Buffer.from(
    Array.from({ length: 200 }, (_, i) => `row ${i}\n`).join(""),
  );
  const first = hashObject("blob", content);
  const seed = store.batch();
  await seed.put(first, "blob", content, deflateSync(content));
  await seed.flush();
  const entries: Buffer[] = [];
  const oids = [first];
  for (let i = 0; i < MAX_DELTA_DEPTH + 2; i++) {
    const delta = appendDelta(content, `v${i}\n`);
    entries.push(
      packEntry(
        7,
        delta.length,
        Buffer.from(oids[oids.length - 1]!, "hex"),
        deflateSync(delta),
      ),
    );
    content = Buffer.concat([content, Buffer.from(`v${i}\n`)]);
    oids.push(hashObject("blob", content));
  }
  await ingestPack(store, await packOf(entries));
  const depths = oids.map(
    (oid) =>
      (
        db.query("SELECT depth FROM objects WHERE oid = ?").get(oid) as {
          depth: number;
        }
      ).depth,
  );
  expect(depths).toEqual([0, 1, 2, 3, 4, 0, 1]);
  expect((await store.read(oids[oids.length - 1]!))?.content).toEqual(content);
});

test("a pack whose deltas use bases from the same pack is written with one R2 request and no reads", async () => {
  const { ingestPack } = await import("../src/pack");
  const { calls, store } = setup();
  const base = Buffer.from(
    Array.from({ length: 300 }, (_, i) => `line ${i}\n`).join(""),
  );
  const baseOid = hashObject("blob", base);
  const entries = [
    packEntry(3, base.length, Buffer.alloc(0), deflateSync(base)),
  ];
  let content = base;
  let previous = baseOid;
  for (let i = 0; i < 3; i++) {
    const delta = appendDelta(content, `step ${i}\n`);
    entries.push(
      packEntry(
        7,
        delta.length,
        Buffer.from(previous, "hex"),
        deflateSync(delta),
      ),
    );
    content = Buffer.concat([content, Buffer.from(`step ${i}\n`)]);
    previous = hashObject("blob", content);
  }
  const added = await ingestPack(store, await packOf(entries));
  expect(added.size).toBe(4);
  expect(calls.put).toBe(1);
  expect(calls.get).toBe(0);
  expect((await store.read(previous))?.content).toEqual(content);
});
