// Runs the real push and clone code of several selfgit revisions against metered mocks of the
// Cloudflare bindings, so the operations Cloudflare bills for can be compared version by version.
//
//   bun scripts/bench-quota.ts <out.json> <label>=<rev> [<label>=<rev> ...]
//
// Every revision ingests the same history, a fresh push of everything up to the tip and then a
// push of the tip commit alone, and then serves a full clone.
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const ZERO = "0".repeat(40);

interface Meter {
  r2: Record<"get" | "head" | "put" | "list" | "delete", number> & {
    bytesWritten: number;
  };
  sql: { rowsRead: number; rowsWritten: number };
}

const emptyMeter = (): Meter => ({
  r2: { get: 0, head: 0, put: 0, list: 0, delete: 0, bytesWritten: 0 },
  sql: { rowsRead: 0, rowsWritten: 0 },
});

function git(cwd: string, args: string[], input?: Buffer | string) {
  const result = spawnSync("git", args, {
    cwd,
    input,
    maxBuffer: 1 << 30,
  });
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout as Buffer;
}

function pkt(payload: Buffer | string): Buffer {
  const data = Buffer.from(payload);
  return Buffer.concat([
    Buffer.from((data.length + 4).toString(16).padStart(4, "0")),
    data,
  ]);
}

function sidebandData(stream: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let pos = 0; pos < stream.length;) {
    const length = parseInt(stream.toString("latin1", pos, pos + 4), 16);
    if (length === 0) {
      pos += 4;
      continue;
    }
    const payload = stream.subarray(pos + 4, pos + length);
    if (payload[0] === 1) parts.push(payload.subarray(1));
    else if (payload[0] === 2) process.stderr.write(payload.subarray(1));
    pos += length;
  }
  return Buffer.concat(parts);
}

function metered() {
  const meter = emptyMeter();
  const db = new Database(":memory:");
  const sql = {
    exec(query: string, ...args: unknown[]) {
      const rows = db.query(query).all(...args);
      if (/^\s*(select|pragma)/i.test(query)) meter.sql.rowsRead += rows.length;
      else if (/^\s*(insert|update|delete)/i.test(query))
        meter.sql.rowsWritten += (
          db.query("SELECT changes() AS n").get() as { n: number }
        ).n;
      return {
        toArray: () => rows,
        one: () => rows[0],
        [Symbol.iterator]: () => rows[Symbol.iterator](),
      };
    },
  } as unknown as SqlStorage;
  const data = new Map<string, Uint8Array>();
  const bucket = {
    async put(key: string, value: Uint8Array | string) {
      meter.r2.put++;
      const bytes =
        typeof value === "string" ? Buffer.from(value) : Uint8Array.from(value);
      meter.r2.bytesWritten += bytes.length;
      data.set(key, bytes);
    },
    async get(
      key: string,
      options?: { range?: { offset: number; length: number } },
    ) {
      meter.r2.get++;
      const value = data.get(key);
      if (!value) return null;
      const range = options?.range;
      const part = range
        ? value.slice(range.offset, range.offset + range.length)
        : value;
      return {
        arrayBuffer: async () => Uint8Array.from(part).buffer,
        json: async () => JSON.parse(Buffer.from(part).toString()),
      };
    },
    async head(key: string) {
      meter.r2.head++;
      return data.has(key) ? {} : null;
    },
    async delete(keys: string | string[]) {
      for (const key of [keys].flat()) {
        meter.r2.delete++;
        data.delete(key);
      }
    },
    async list() {
      meter.r2.list++;
      return { objects: [], truncated: false };
    },
  } as unknown as R2Bucket;
  return {
    sql,
    bucket,
    db,
    meter,
    reset() {
      Object.assign(meter, emptyMeter());
    },
    snapshot: () => structuredClone(meter),
  };
}

async function runOne(dir: string, tip: string, previous: string) {
  const { ObjectStore } = await import(join(dir, "src/objects.ts"));
  const { receivePack, uploadPack } = await import(
    join(dir, "src/protocol.ts")
  );
  const rig = metered();
  const store = new ObjectStore(rig.sql, rig.bucket, "bench");
  const transaction = (fn: () => void) => rig.db.transaction(fn)();
  const cpu = () => {
    const usage = process.cpuUsage();
    return (usage.user + usage.system) / 1000;
  };

  const push = async (old: string, next: string, revs: string) => {
    const pack = git(
      ROOT,
      [
        "pack-objects",
        "--revs",
        "--stdout",
        "--thin",
        "--delta-base-offset",
        "-q",
      ],
      revs,
    );
    const command = Buffer.from(
      `${old} ${next} refs/heads/main\0report-status ofs-delta\n`,
    );
    const body = Buffer.concat([pkt(command), Buffer.from("0000"), pack]);
    rig.reset();
    const started = cpu();
    const response = (await receivePack(store, transaction, body)).toString();
    if (!response.includes("ok refs/heads/main"))
      throw new Error(`push rejected: ${response}`);
    return {
      ...rig.snapshot(),
      cpuMs: cpu() - started,
      packBytes: pack.length,
    };
  };

  const initial = await push(ZERO, previous, `${previous}\n`);
  // The incremental push is the tip commit alone, as a thin pack against what the server holds.
  const incremental = await push(previous, tip, `${tip}\n^${previous}\n`);

  const want = pkt(
    `want ${tip} multi_ack_detailed no-done side-band-64k thin-pack ofs-delta agent=git/bench\n`,
  );
  const request = Buffer.concat([want, Buffer.from("0000"), pkt("done\n")]);
  const runs: { cpuMs: number; bytes: number; meter: Meter }[] = [];
  let pack = Buffer.alloc(0);
  for (let i = 0; i < 5; i++) {
    store.clearReadCache();
    rig.reset();
    const started = cpu();
    const response = await uploadPack(store, request);
    const chunks: Buffer[] = [];
    if (Buffer.isBuffer(response)) chunks.push(response);
    else {
      const reader = (response as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
      }
    }
    const stream = Buffer.concat(chunks);
    runs.push({
      cpuMs: cpu() - started,
      bytes: stream.length,
      meter: rig.snapshot(),
    });
    pack = sidebandData(stream);
  }

  const verify = mkdtempSync(join(tmpdir(), "bench-verify-"));
  git(verify, ["init", "-q", "--bare", "."]);
  const indexed = spawnSync("git", ["index-pack", "--stdin", "--strict"], {
    cwd: verify,
    input: pack,
  });
  rmSync(verify, { recursive: true, force: true });
  if (indexed.status !== 0)
    throw new Error(`clone pack rejected by git: ${indexed.stderr}`);

  const sorted = runs.map((run) => run.cpuMs).sort((a, b) => a - b);
  const first = runs[0]!;
  return {
    objects: Number(
      git(ROOT, ["rev-list", "--objects", tip])
        .toString()
        .split("\n")
        .filter(Boolean).length,
    ),
    initialPush: initial,
    incrementalPush: incremental,
    clone: {
      ...first.meter,
      wireBytes: first.bytes,
      packBytes: pack.length,
      cpuMs: sorted[Math.floor(sorted.length / 2)],
      gitAccepts: true,
    },
  };
}

if (process.argv[2] === "run") {
  const [, , , dir, tip, previous] = process.argv as string[];
  process.stdout.write(JSON.stringify(await runOne(dir!, tip!, previous!)));
} else {
  const [out, ...specs] = process.argv.slice(2);
  if (!out || specs.length === 0)
    throw new Error("usage: bench-quota.ts <out.json> <label>=<rev> ...");
  const tipRev = process.env.BENCH_TIP ?? "9af8707";
  const tip = git(ROOT, ["rev-parse", tipRev]).toString().trim();
  const previous = git(ROOT, ["rev-parse", `${tip}^`])
    .toString()
    .trim();
  const results: Record<string, unknown> = {};
  for (const spec of specs) {
    const [label, rev] = spec.split("=") as [string, string];
    const dir = mkdtempSync(join(tmpdir(), "bench-rev-"));
    git(ROOT, ["worktree", "add", "-q", "--detach", join(dir, "tree"), rev]);
    symlinkSync(join(ROOT, "node_modules"), join(dir, "tree/node_modules"));
    try {
      const result = spawnSync(
        "bun",
        [import.meta.path, "run", join(dir, "tree"), tip, previous],
        { encoding: "utf8", maxBuffer: 1 << 30 },
      );
      if (result.status !== 0)
        throw new Error(`${label}: ${result.stderr || result.stdout}`);
      results[label] = { rev, ...JSON.parse(result.stdout) };
      console.error(`measured ${label} (${rev})`);
    } finally {
      git(ROOT, ["worktree", "remove", "--force", join(dir, "tree")]);
      rmSync(dir, { recursive: true, force: true });
    }
  }
  writeFileSync(out, JSON.stringify({ tip, previous, results }, null, 2));
}
