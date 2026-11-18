import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

export const OBJECT_TYPES = ["commit", "tree", "blob", "tag"] as const;
export type ObjectType = (typeof OBJECT_TYPES)[number];
export const TYPE_CODE: Record<ObjectType, number> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
};
export const ZERO_OID = "0".repeat(40);

export class CorruptObject extends Error {}

export interface ObjectInfo {
  type: ObjectType;
  size: number;
  /** commit: [tree, ...parents]; tag: [target]; tree: non-gitlink entries; blob: []. */
  links: string[];
}

export function typeFromCode(code: number): ObjectType | undefined {
  return OBJECT_TYPES[code - 1];
}

export function hashObject(type: ObjectType, content: Uint8Array): string {
  return createHash("sha1")
    .update(`${type} ${content.length}\0`)
    .update(content)
    .digest("hex");
}

const HEX40 = /^[0-9a-f]{40}$/;

export function isOid(value: string): boolean {
  return HEX40.test(value);
}

function headerLines(content: Buffer): string[] {
  const end = content.indexOf("\n\n");
  return content
    .toString("latin1", 0, end === -1 ? content.length : end)
    .split("\n");
}

export function parseLinks(type: ObjectType, content: Buffer): string[] {
  switch (type) {
    case "blob":
      return [];
    case "tree": {
      const links: string[] = [];
      let pos = 0;
      while (pos < content.length) {
        const space = content.indexOf(0x20, pos);
        const nul = content.indexOf(0, space + 1);
        if (space === -1 || nul === -1 || nul + 21 > content.length)
          throw new CorruptObject("malformed tree");
        const mode = content.toString("latin1", pos, space);
        if (mode !== "160000")
          links.push(content.toString("hex", nul + 1, nul + 21));
        pos = nul + 21;
      }
      return links;
    }
    case "commit": {
      const lines = headerLines(content);
      const tree = lines[0]?.startsWith("tree ") ? lines[0].slice(5) : "";
      if (!isOid(tree)) throw new CorruptObject("commit without tree");
      const parents = lines
        .slice(1)
        .filter((line) => line.startsWith("parent "))
        .map((line) => line.slice(7));
      if (!parents.every(isOid))
        throw new CorruptObject("malformed commit parent");
      return [tree, ...parents];
    }
    case "tag": {
      const target = headerLines(content)[0]?.startsWith("object ")
        ? headerLines(content)[0]!.slice(7)
        : "";
      if (!isOid(target)) throw new CorruptObject("tag without object");
      return [target];
    }
  }
}

interface ObjectRow extends Record<string, SqlStorageValue> {
  type: number;
  size: number;
  links: string;
}

export async function deleteRepoObjects(
  bucket: R2Bucket,
  repoId: string,
): Promise<void> {
  const prefix = `${repoId}/`;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    if (page.objects.length)
      await bucket.delete(page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

/** Objects of one push are stored back to back in a single R2 object so a clone costs a few requests. */
const BUNDLE_BYTES = 8 << 20;
/** Two wanted objects this close together in a bundle are fetched with one range request. */
const RANGE_GAP = 64 << 10;
const FETCH_CONCURRENCY = 16;
const REPACK_ROWS = 2000;

interface Staged {
  oid: string;
  type: number;
  size: number;
  links: string;
  zdata: Uint8Array;
}

interface Placement extends Record<string, SqlStorageValue> {
  in_r2: number;
  bundle: string | null;
  off: number | null;
  len: number | null;
}

async function pool<T>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await work(items[next++]!);
    }),
  );
}

const READ_CACHE_BYTES = 4 * 1024 * 1024;
const READ_CACHE_ENTRY_BYTES = 256 * 1024;
const READ_CACHE_ENTRY_OVERHEAD = 512;

export class ObjectStore {
  private readonly readCache = new Map<
    string,
    { type: ObjectType; content: Buffer }
  >();
  private readonly reads = new Map<
    string,
    Promise<{ type: ObjectType; content: Buffer } | null>
  >();
  private readCacheBytes = 0;
  private readonly verifiedBundles = new Set<string>();

  clearReadCache(): void {
    this.readCache.clear();
    this.readCacheBytes = 0;
    this.verifiedBundles.clear();
  }

  constructor(
    private readonly sql: SqlStorage,
    private readonly bucket: R2Bucket,
    private readonly repoId: string,
  ) {
    sql.exec(`CREATE TABLE IF NOT EXISTS objects (
      oid TEXT PRIMARY KEY,
      type INTEGER NOT NULL,
      size INTEGER NOT NULL,
      links TEXT NOT NULL,
      zdata BLOB
    ) WITHOUT ROWID`);
    sql.exec(`CREATE TABLE IF NOT EXISTS object_chunks (
      oid TEXT NOT NULL,
      seq INTEGER NOT NULL,
      data BLOB NOT NULL,
      PRIMARY KEY (oid, seq)
    ) WITHOUT ROWID`);
    const columns = sql
      .exec<{ name: string }>("PRAGMA table_info(objects)")
      .toArray();
    if (!columns.some((column) => column.name === "in_r2"))
      sql.exec(
        "ALTER TABLE objects ADD COLUMN in_r2 INTEGER NOT NULL DEFAULT 0",
      );
    for (const [name, type] of [
      ["bundle", "TEXT"],
      ["off", "INTEGER"],
      ["len", "INTEGER"],
    ] as const)
      if (!columns.some((column) => column.name === name))
        sql.exec(`ALTER TABLE objects ADD COLUMN ${name} ${type}`);
    sql.exec(
      `CREATE TABLE IF NOT EXISTS refs (name TEXT PRIMARY KEY, oid TEXT NOT NULL) WITHOUT ROWID`,
    );
  }

  async auditR2(after: string) {
    const rows = this.sql
      .exec<{ oid: string; type: number } & Placement>(
        "SELECT oid, type, in_r2, bundle, off, len FROM objects WHERE oid > ? ORDER BY oid LIMIT 20",
        after,
      )
      .toArray();
    const results: { oid: string; status: "valid" | "missing" | "corrupt" }[] =
      [];
    for (const row of rows) {
      const data = await this.payload(row.oid, row);
      if (!data) {
        results.push({ oid: row.oid, status: "missing" });
        continue;
      }
      try {
        const type = typeFromCode(row.type);
        if (!type) throw new CorruptObject("invalid type");
        this.verify(row.oid, type, data);
        results.push({ oid: row.oid, status: "valid" });
      } catch {
        results.push({ oid: row.oid, status: "corrupt" });
      }
    }
    return {
      results,
      next: rows.length === 20 ? rows[rows.length - 1]!.oid : null,
    };
  }

  async has(oid: string): Promise<boolean> {
    const row = this.sql
      .exec<Placement>(
        "SELECT in_r2, bundle, off, len FROM objects WHERE oid = ?",
        oid,
      )
      .toArray()[0];
    if (!row) return false;
    if (!row.in_r2) return true;
    if (!row.bundle) return (await this.bucket.head(this.key(oid))) !== null;
    if (this.verifiedBundles.has(row.bundle)) return true;
    if ((await this.bucket.head(row.bundle)) === null) return false;
    this.verifiedBundles.add(row.bundle);
    return true;
  }

  info(oid: string): ObjectInfo | null {
    const row = this.sql
      .exec<ObjectRow>(
        "SELECT type, size, links FROM objects WHERE oid = ?",
        oid,
      )
      .toArray()[0];
    if (!row) return null;
    return {
      type: typeFromCode(row.type)!,
      size: row.size,
      links: row.links ? row.links.split(" ") : [],
    };
  }

  private key(oid: string): string {
    return `${this.repoId}/${oid}`;
  }

  /** Reads legacy SQLite payloads and migrates them only after verifying the R2 copy. */
  async zdata(oid: string): Promise<Buffer> {
    const row = this.sql
      .exec<{ zdata: ArrayBuffer | null } & Placement>(
        "SELECT zdata, in_r2, bundle, off, len FROM objects WHERE oid = ?",
        oid,
      )
      .toArray()[0];
    if (!row) throw new CorruptObject(`missing object ${oid}`);
    const info = this.info(oid)!;
    if (row.in_r2) {
      const data = await this.payload(oid, row);
      if (!data) throw new CorruptObject(`missing R2 object ${oid}`);
      this.verify(oid, info.type, data);
      return data;
    }
    const data = row.zdata
      ? Buffer.from(row.zdata)
      : Buffer.concat(
          this.sql
            .exec<{ data: ArrayBuffer }>(
              "SELECT data FROM object_chunks WHERE oid = ? ORDER BY seq",
              oid,
            )
            .toArray()
            .map((chunk) => Buffer.from(chunk.data)),
        );
    this.verify(oid, info.type, data);
    await this.bucket.put(this.key(oid), data);
    const copy = await this.bucket.get(this.key(oid));
    if (!copy) throw new CorruptObject(`missing R2 object ${oid} after upload`);
    this.verify(oid, info.type, Buffer.from(await copy.arrayBuffer()));
    this.sql.exec("UPDATE objects SET in_r2 = 1 WHERE oid = ?", oid);
    return data;
  }

  /** The stored bytes of an R2-backed object, or null when R2 no longer has them. */
  private async payload(oid: string, row: Placement): Promise<Buffer | null> {
    const object = row.bundle
      ? await this.bucket.get(row.bundle, {
          range: { offset: row.off!, length: row.len! },
        })
      : await this.bucket.get(this.key(oid));
    return object ? Buffer.from(await object.arrayBuffer()) : null;
  }

  /**
   * Reads many objects at once. Objects that share a bundle and sit close together come back from
   * one range request, so the cost is a few round trips instead of one per object.
   */
  async zdataBatch(oids: string[]): Promise<Map<string, Buffer>> {
    const out = new Map<string, Buffer>();
    const byBundle = new Map<
      string,
      { oid: string; off: number; len: number }[]
    >();
    const single: string[] = [];
    for (const oid of oids) {
      const row = this.sql
        .exec<Placement>(
          "SELECT in_r2, bundle, off, len FROM objects WHERE oid = ?",
          oid,
        )
        .toArray()[0];
      if (row?.in_r2 && row.bundle) {
        const items = byBundle.get(row.bundle) ?? [];
        items.push({ oid, off: row.off!, len: row.len! });
        byBundle.set(row.bundle, items);
      } else single.push(oid);
    }
    const reads: (() => Promise<void>)[] = [];
    for (const [bundle, items] of byBundle) {
      items.sort((a, b) => a.off - b.off);
      let group = [items[0]!];
      const close = () => {
        const members = group;
        reads.push(() => this.readRange(bundle, members, out));
      };
      for (const item of items.slice(1)) {
        const last = group[group.length - 1]!;
        if (
          item.off - (last.off + last.len) > RANGE_GAP ||
          item.off + item.len - group[0]!.off > BUNDLE_BYTES
        ) {
          close();
          group = [];
        }
        group.push(item);
      }
      close();
    }
    for (const oid of single)
      reads.push(async () => void out.set(oid, await this.zdata(oid)));
    await pool(reads, FETCH_CONCURRENCY, (read) => read());
    return out;
  }

  private async readRange(
    bundle: string,
    items: { oid: string; off: number; len: number }[],
    out: Map<string, Buffer>,
  ): Promise<void> {
    const start = items[0]!.off;
    const last = items[items.length - 1]!;
    const object = await this.bucket.get(bundle, {
      range: { offset: start, length: last.off + last.len - start },
    });
    if (!object) throw new CorruptObject(`missing R2 bundle ${bundle}`);
    const bytes = Buffer.from(await object.arrayBuffer());
    for (const item of items) {
      const data = bytes.subarray(
        item.off - start,
        item.off - start + item.len,
      );
      this.verify(item.oid, this.info(item.oid)!.type, data);
      out.set(item.oid, data);
    }
  }

  private verify(oid: string, type: ObjectType, data: Uint8Array): void {
    let content: Buffer;
    try {
      content = inflateSync(data);
    } catch {
      throw new CorruptObject(`invalid compressed object ${oid}`);
    }
    if (hashObject(type, content) !== oid)
      throw new CorruptObject(`object hash mismatch ${oid}`);
  }

  async read(
    oid: string,
  ): Promise<{ type: ObjectType; content: Buffer } | null> {
    const cached = this.readCache.get(oid);
    if (cached) {
      this.readCache.delete(oid);
      this.readCache.set(oid, cached);
      return cached;
    }
    const pending = this.reads.get(oid);
    if (pending) return pending;
    const load = (async () => {
      const info = this.info(oid);
      if (!info) return null;
      const object = {
        type: info.type,
        content: inflateSync(await this.zdata(oid)),
      };
      if (
        (info.type === "commit" || info.type === "tree") &&
        object.content.length <= READ_CACHE_ENTRY_BYTES
      ) {
        while (
          this.readCacheBytes +
            object.content.length +
            READ_CACHE_ENTRY_OVERHEAD >
          READ_CACHE_BYTES
        ) {
          const oldest = this.readCache.keys().next().value;
          if (oldest === undefined) break;
          this.readCacheBytes -=
            this.readCache.get(oldest)!.content.length +
            READ_CACHE_ENTRY_OVERHEAD;
          this.readCache.delete(oldest);
        }
        this.readCache.set(oid, object);
        this.readCacheBytes +=
          object.content.length + READ_CACHE_ENTRY_OVERHEAD;
      }
      return object;
    })();
    this.reads.set(oid, load);
    try {
      return await load;
    } finally {
      this.reads.delete(oid);
    }
  }

  /**
   * Collects the objects of one push and writes them as a single R2 bundle. Nothing is visible to
   * readers until flush() has stored the bundle, so a failed upload leaves no metadata behind.
   */
  batch() {
    const staged = new Map<string, Staged>();
    let bytes = 0;
    const flush = async () => {
      if (staged.size === 0) return;
      await this.commit([...staged.values()]);
      staged.clear();
      bytes = 0;
    };
    return {
      put: async (
        oid: string,
        type: ObjectType,
        content: Buffer,
        zdata: Uint8Array,
      ): Promise<boolean> => {
        if (hashObject(type, content) !== oid)
          throw new CorruptObject(`object hash mismatch ${oid}`);
        this.verify(oid, type, zdata);
        if (staged.has(oid) || (await this.has(oid))) return false;
        staged.set(oid, {
          oid,
          type: TYPE_CODE[type],
          size: content.length,
          links: parseLinks(type, content).join(" "),
          zdata,
        });
        bytes += zdata.length;
        if (bytes >= BUNDLE_BYTES) await flush();
        return true;
      },
      flush,
      /** True while the object is held in memory and not yet readable from the store. */
      has: (oid: string) => staged.has(oid),
      discard: () => {
        staged.clear();
        bytes = 0;
      },
    };
  }

  private async commit(items: Staged[]): Promise<void> {
    const bundle = Buffer.concat(items.map((item) => item.zdata));
    const key = `${this.repoId}/pack-${createHash("sha1").update(bundle).digest("hex")}`;
    await this.bucket.put(key, bundle);
    this.verifiedBundles.add(key);
    let off = 0;
    for (const item of items) {
      this.sql.exec(
        `INSERT INTO objects (oid, type, size, links, zdata, in_r2, bundle, off, len)
         VALUES (?, ?, ?, ?, NULL, 1, ?, ?, ?)
         ON CONFLICT (oid) DO UPDATE SET in_r2 = 1, bundle = excluded.bundle, off = excluded.off, len = excluded.len`,
        item.oid,
        item.type,
        item.size,
        item.links,
        key,
        off,
        item.zdata.length,
      );
      off += item.zdata.length;
    }
  }

  /**
   * Moves objects stored as one R2 object each into bundles. Each call handles a bounded slice and
   * returns how many rows are left, so callers loop until it reaches zero. Rows switch to the
   * bundle before the old keys are deleted, so an interrupted run never loses an object.
   */
  async repack(): Promise<{ moved: number; remaining: number }> {
    const rows = this.sql
      .exec<{ oid: string; type: number; size: number }>(
        "SELECT oid, type, size FROM objects WHERE in_r2 = 1 AND bundle IS NULL ORDER BY oid LIMIT ?",
        REPACK_ROWS,
      )
      .toArray();
    const slice: typeof rows = [];
    let uncompressed = 0;
    for (const row of rows) {
      if (slice.length > 0 && uncompressed + row.size > BUNDLE_BYTES) break;
      slice.push(row);
      uncompressed += row.size;
    }
    if (slice.length > 0) {
      const data = await this.zdataBatch(slice.map((row) => row.oid));
      await this.commit(
        slice.map((row) => ({
          oid: row.oid,
          type: row.type,
          size: row.size,
          links: "",
          zdata: data.get(row.oid)!,
        })),
      );
      for (let i = 0; i < slice.length; i += 1000)
        await this.bucket.delete(
          slice.slice(i, i + 1000).map((row) => this.key(row.oid)),
        );
    }
    const remaining = this.sql
      .exec<{ count: number }>(
        "SELECT count(*) AS count FROM objects WHERE in_r2 = 1 AND bundle IS NULL",
      )
      .one().count;
    return { moved: slice.length, remaining };
  }

  refs(): Map<string, string> {
    const refs = new Map<string, string>();
    for (const row of this.sql.exec<{ name: string; oid: string }>(
      "SELECT name, oid FROM refs ORDER BY name",
    )) {
      refs.set(row.name, row.oid);
    }
    return refs;
  }

  setRef(name: string, oid: string): void {
    if (oid === ZERO_OID)
      this.sql.exec("DELETE FROM refs WHERE name = ?", name);
    else
      this.sql.exec(
        "INSERT INTO refs (name, oid) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET oid = excluded.oid",
        name,
        oid,
      );
  }

  /** Follows tag objects to the first non-tag object. */
  peel(oid: string): string {
    let current = oid;
    for (
      let info = this.info(current);
      info?.type === "tag";
      info = this.info(current)
    )
      current = info.links[0]!;
    return current;
  }
}
