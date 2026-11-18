import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { deflateSync } from "node:zlib";
import { Browser } from "../src/browse";
import { treeSnapshot } from "../src/tree-snapshot";
import { hashObject, ObjectStore, type ObjectType } from "../src/objects";

test("tree history retains last commits while avoiding repeated object reads", async () => {
  const db = new Database(":memory:");
  const sql = {
    exec(query: string, ...args: unknown[]) {
      const rows = db.query(query).all(...args);
      return {
        toArray: () => rows,
        [Symbol.iterator]: () => rows[Symbol.iterator](),
      };
    },
  } as unknown as SqlStorage;
  const data = new Map<string, Uint8Array>();
  let reads = 0;
  const bucket = {
    async put(key: string, value: Uint8Array | string) {
      data.set(
        key,
        typeof value === "string" ? Buffer.from(value) : Uint8Array.from(value),
      );
    },
    async get(key: string) {
      reads++;
      const value = data.get(key);
      return value
        ? {
            arrayBuffer: async () => Uint8Array.from(value).buffer,
            json: async () => JSON.parse(Buffer.from(value).toString()),
          }
        : null;
    },
    async head(key: string) {
      return data.has(key) ? {} : null;
    },
  } as unknown as R2Bucket;
  const store = new ObjectStore(sql, bucket, "repo");
  async function put(type: ObjectType, content: Buffer) {
    const oid = hashObject(type, content);
    const batch = store.batch();
    await batch.put(oid, type, content, deflateSync(content));
    await batch.flush();
    return oid;
  }
  const stable = await put("blob", Buffer.from("stable"));
  let parent = "";
  let first = "";
  for (let i = 0; i < 120; i++) {
    const changing = await put("blob", Buffer.from(`version ${i}`));
    const tree = await put(
      "tree",
      Buffer.concat([
        Buffer.from("100644 changing\0"),
        Buffer.from(changing, "hex"),
        Buffer.from("100644 stable\0"),
        Buffer.from(stable, "hex"),
      ]),
    );
    parent = await put(
      "commit",
      Buffer.from(
        `tree ${tree}\n${parent ? `parent ${parent}\n` : ""}author A <a@b> ${i + 1} +0000\ncommitter A <a@b> ${i + 1} +0000\n\ncommit ${i}\n`,
      ),
    );
    if (!first) first = parent;
  }
  store.setRef("refs/heads/main", parent);
  reads = 0;
  const pair = await Promise.all([store.read(parent), store.read(parent)]);
  expect(pair[0]).toEqual(pair[1]);
  expect(reads).toBe(1);
  store.clearReadCache();
  reads = 0;
  const cold = await new Browser(store).treeView("main", "");
  const coldReads = reads;
  reads = 0;
  const warm = await new Browser(store).treeView("main", "");
  const warmReads = reads;
  expect(warm).toEqual(cold);
  expect(
    Object.fromEntries(
      cold.entries.map((entry) => [entry.name, entry.lastCommit?.oid]),
    ),
  ).toEqual({ changing: parent, stable: first });
  expect(coldReads).toBe(240);
  expect(warmReads).toBe(0);
  store.setRef("refs/heads/main", first);
  const moved = await new Browser(store).treeView("main", "");
  expect(moved.commit.oid).toBe(first);
  expect(moved.entries.every((entry) => entry.lastCommit?.oid === first)).toBe(
    true,
  );
  store.setRef("refs/heads/main", parent);
  const snapshot = await treeSnapshot(
    new Browser(store),
    bucket,
    "repo",
    "main",
    "",
  );
  expect(snapshot).toEqual(cold);
  store.clearReadCache();
  reads = 0;
  expect(
    await treeSnapshot(new Browser(store), bucket, "repo", "main", "/"),
  ).toEqual(cold);
  expect(reads).toBe(1);
  store.setRef("refs/heads/main", first);
  expect(
    await treeSnapshot(new Browser(store), bucket, "repo", "main", ""),
  ).toEqual(moved);
  store.setRef("refs/heads/new", parent);
  expect(
    await treeSnapshot(new Browser(store), bucket, "repo", "new", ""),
  ).toEqual(cold);
  expect(
    [...data.keys()].filter((key) => key.includes("tree-snapshots")),
  ).toHaveLength(2);
});
