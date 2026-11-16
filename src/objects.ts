import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

export const OBJECT_TYPES = ["commit", "tree", "blob", "tag"] as const;
export type ObjectType = (typeof OBJECT_TYPES)[number];
export const TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const ZERO_OID = "0".repeat(40);

/** Durable Object SQLite rows max out at 8 MB; stored zlib data is split well below that. */
const CHUNK_BYTES = 1 << 20;

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
  return createHash("sha1").update(`${type} ${content.length}\0`).update(content).digest("hex");
}

const HEX40 = /^[0-9a-f]{40}$/;

export function isOid(value: string): boolean {
  return HEX40.test(value);
}

function headerLines(content: Buffer): string[] {
  const end = content.indexOf("\n\n");
  return content.toString("latin1", 0, end === -1 ? content.length : end).split("\n");
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
        if (space === -1 || nul === -1 || nul + 21 > content.length) throw new CorruptObject("malformed tree");
        const mode = content.toString("latin1", pos, space);
        if (mode !== "160000") links.push(content.toString("hex", nul + 1, nul + 21));
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
      if (!parents.every(isOid)) throw new CorruptObject("malformed commit parent");
      return [tree, ...parents];
    }
    case "tag": {
      const target = headerLines(content)[0]?.startsWith("object ") ? headerLines(content)[0]!.slice(7) : "";
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

export class ObjectStore {
  constructor(private readonly sql: SqlStorage) {
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
    sql.exec(`CREATE TABLE IF NOT EXISTS refs (name TEXT PRIMARY KEY, oid TEXT NOT NULL) WITHOUT ROWID`);
  }

  has(oid: string): boolean {
    return this.sql.exec("SELECT 1 FROM objects WHERE oid = ?", oid).toArray().length > 0;
  }

  info(oid: string): ObjectInfo | null {
    const row = this.sql.exec<ObjectRow>("SELECT type, size, links FROM objects WHERE oid = ?", oid).toArray()[0];
    if (!row) return null;
    return { type: typeFromCode(row.type)!, size: row.size, links: row.links ? row.links.split(" ") : [] };
  }

  /** The object's zlib stream, exactly as a non-delta pack entry carries it. */
  *zdata(oid: string): Generator<Buffer> {
    const row = this.sql.exec<{ zdata: ArrayBuffer | null }>("SELECT zdata FROM objects WHERE oid = ?", oid).toArray()[0];
    if (!row) throw new CorruptObject(`missing object ${oid}`);
    if (row.zdata) {
      yield Buffer.from(row.zdata);
      return;
    }
    for (const chunk of this.sql.exec<{ data: ArrayBuffer }>(
      "SELECT data FROM object_chunks WHERE oid = ? ORDER BY seq",
      oid,
    )) {
      yield Buffer.from(chunk.data);
    }
  }

  read(oid: string): { type: ObjectType; content: Buffer } | null {
    const info = this.info(oid);
    if (!info) return null;
    return { type: info.type, content: inflateSync(Buffer.concat([...this.zdata(oid)])) };
  }

  /** Stores an object unless present. Returns true when the object is new. */
  put(oid: string, type: ObjectType, content: Buffer, zdata: Uint8Array): boolean {
    if (this.has(oid)) return false;
    const links = parseLinks(type, content).join(" ");
    const inline = zdata.length <= CHUNK_BYTES;
    this.sql.exec(
      "INSERT INTO objects (oid, type, size, links, zdata) VALUES (?, ?, ?, ?, ?)",
      oid,
      TYPE_CODE[type],
      content.length,
      links,
      inline ? zdata : null,
    );
    if (!inline) {
      for (let seq = 0; seq * CHUNK_BYTES < zdata.length; seq++) {
        const part = zdata.subarray(seq * CHUNK_BYTES, (seq + 1) * CHUNK_BYTES);
        this.sql.exec("INSERT INTO object_chunks (oid, seq, data) VALUES (?, ?, ?)", oid, seq, part);
      }
    }
    return true;
  }

  refs(): Map<string, string> {
    const refs = new Map<string, string>();
    for (const row of this.sql.exec<{ name: string; oid: string }>("SELECT name, oid FROM refs ORDER BY name")) {
      refs.set(row.name, row.oid);
    }
    return refs;
  }

  setRef(name: string, oid: string): void {
    if (oid === ZERO_OID) this.sql.exec("DELETE FROM refs WHERE name = ?", name);
    else this.sql.exec("INSERT INTO refs (name, oid) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET oid = excluded.oid", name, oid);
  }

  /** Follows tag objects to the first non-tag object. */
  peel(oid: string): string {
    let current = oid;
    for (let info = this.info(current); info?.type === "tag"; info = this.info(current)) current = info.links[0]!;
    return current;
  }
}
