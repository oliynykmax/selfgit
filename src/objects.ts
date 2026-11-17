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

  clearReadCache(): void {
    this.readCache.clear();
    this.readCacheBytes = 0;
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
    sql.exec(
      `CREATE TABLE IF NOT EXISTS refs (name TEXT PRIMARY KEY, oid TEXT NOT NULL) WITHOUT ROWID`,
    );
  }

  async auditR2(after: string) {
    const rows = this.sql
      .exec<{ oid: string; type: number }>(
        "SELECT oid, type FROM objects WHERE oid > ? ORDER BY oid LIMIT 20",
        after,
      )
      .toArray();
    const results: { oid: string; status: "valid" | "missing" | "corrupt" }[] =
      [];
    for (const row of rows) {
      const object = await this.bucket.get(this.key(row.oid));
      if (!object) {
        results.push({ oid: row.oid, status: "missing" });
        continue;
      }
      try {
        const type = typeFromCode(row.type);
        if (!type) throw new CorruptObject("invalid type");
        this.verify(row.oid, type, Buffer.from(await object.arrayBuffer()));
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
      .exec<{ in_r2: number }>("SELECT in_r2 FROM objects WHERE oid = ?", oid)
      .toArray()[0];
    if (!row) return false;
    return !row.in_r2 || (await this.bucket.head(this.key(oid))) !== null;
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
      .exec<{ zdata: ArrayBuffer | null; in_r2: number }>(
        "SELECT zdata, in_r2 FROM objects WHERE oid = ?",
        oid,
      )
      .toArray()[0];
    if (!row) throw new CorruptObject(`missing object ${oid}`);
    const info = this.info(oid)!;
    if (row.in_r2) {
      const object = await this.bucket.get(this.key(oid));
      if (!object) throw new CorruptObject(`missing R2 object ${oid}`);
      const data = Buffer.from(await object.arrayBuffer());
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

  async put(
    oid: string,
    type: ObjectType,
    content: Buffer,
    zdata: Uint8Array,
  ): Promise<boolean> {
    if (hashObject(type, content) !== oid)
      throw new CorruptObject(`object hash mismatch ${oid}`);
    this.verify(oid, type, zdata);
    if (await this.has(oid)) return false;
    const links = parseLinks(type, content).join(" ");
    await this.bucket.put(this.key(oid), zdata);
    this.sql.exec(
      "INSERT OR IGNORE INTO objects (oid, type, size, links, zdata, in_r2) VALUES (?, ?, ?, ?, NULL, 1)",
      oid,
      TYPE_CODE[type],
      content.length,
      links,
    );
    return true;
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
