import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { deflateSync } from "node:zlib";
import { ObjectStore, hashObject } from "../src/objects";

function setup() {
  const db = new Database(":memory:");
  const sql = { exec(query: string, ...args: unknown[]) {
    const rows = db.query(query).all(...args);
    return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
  } } as unknown as SqlStorage;
  const data = new Map<string, Uint8Array>();
  let fail = false;
  const bucket = {
    async put(key: string, value: Uint8Array) { if (fail) throw new Error("R2 unavailable"); data.set(key, Uint8Array.from(value)); },
    async get(key: string) { const value = data.get(key); return value ? { arrayBuffer: async () => Uint8Array.from(value).buffer } : null; },
    async head(key: string) { return data.has(key) ? {} : null; },
  } as unknown as R2Bucket;
  return { db, data, store: new ObjectStore(sql, bucket, "repo-id"), setFailure(value: boolean) { fail = value; } };
}

test("legacy payload migrates only after verified R2 write and retains SQLite data", async () => {
  const { db, data, store, setFailure } = setup();
  const content = Buffer.from("legacy data");
  const oid = hashObject("blob", content);
  const compressed = deflateSync(content);
  db.query("INSERT INTO objects (oid, type, size, links, zdata) VALUES (?, 3, ?, '', ?)").run(oid, content.length, compressed);
  setFailure(true);
  await expect(store.read(oid)).rejects.toThrow("R2 unavailable");
  expect(db.query("SELECT in_r2 FROM objects WHERE oid = ?").get(oid)).toEqual({ in_r2: 0 });
  setFailure(false);
  expect((await store.read(oid))?.content).toEqual(content);
  expect(data.has(`repo-id/${oid}`)).toBe(true);
  expect(db.query("SELECT in_r2 FROM objects WHERE oid = ?").get(oid)).toEqual({ in_r2: 1 });
  expect(db.query("SELECT zdata FROM objects WHERE oid = ?").get(oid)).toBeTruthy();
  expect((await store.read(oid))?.content).toEqual(content);
});

test("failed R2 upload cannot publish object metadata", async () => {
  const { db, store, setFailure } = setup();
  const content = Buffer.from("new data");
  const oid = hashObject("blob", content);
  setFailure(true);
  await expect(store.put(oid, "blob", content, deflateSync(content))).rejects.toThrow("R2 unavailable");
  expect(db.query("SELECT oid FROM objects WHERE oid = ?").get(oid)).toBeNull();
  setFailure(false);
  expect(await store.put(oid, "blob", content, deflateSync(content))).toBe(true);
  expect(db.query("SELECT zdata, in_r2 FROM objects WHERE oid = ?").get(oid)).toEqual({ zdata: null, in_r2: 1 });
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
  const entry = Buffer.from([0xb0 | (content.length & 15), content.length >> 4]);
  const pack = Buffer.concat([header, entry, deflateSync(content)]);
  const packWithHash = Buffer.concat([pack, createHash("sha1").update(pack).digest()]);
  const line = Buffer.from(`${"0".repeat(40)} ${oid} refs/heads/main\0report-status\n`);
  const body = Buffer.concat([Buffer.from((line.length + 4).toString(16).padStart(4, "0")), line, Buffer.from("0000"), packWithHash]);
  const transaction = (fn: () => void) => db.transaction(fn)();
  setFailure(true);
  await expect(receivePack(store, transaction, body)).rejects.toThrow("R2 unavailable");
  expect(store.refs().size).toBe(0);
  setFailure(false);
  expect((await receivePack(store, transaction, body)).toString()).toContain("ok refs/heads/main");
  expect(store.refs().get("refs/heads/main")).toBe(oid);
});
