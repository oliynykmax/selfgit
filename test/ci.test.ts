import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { CiQueue } from "../src/ci";

test("expired leases are reclaimed and cannot write or finish", () => {
  const db = new Database(":memory:");
  const sql = {
    exec(query: string, ...args: unknown[]) {
      const rows = db.query(query).all(...(args as never[]));
      return { toArray: () => rows, one: () => rows[0] };
    },
  } as unknown as SqlStorage;
  db.run("CREATE TABLE refs (name TEXT PRIMARY KEY, oid TEXT NOT NULL)");
  db.run("INSERT INTO refs VALUES ('refs/heads/main', 'abc')");
  const queue = new CiQueue(sql);
  queue.enqueue("abc");
  const first = queue.claim("ci", 1000)!;
  expect(queue.claim("ci", 1001)).toBeNull();
  const second = queue.claim("ci", first.leaseUntil)!;
  expect(second.id).toBe(first.id);
  expect(second.leaseToken).not.toBe(first.leaseToken);
  expect(queue.log(first.id, first.leaseToken, "late", first.leaseUntil)).toBe(
    false,
  );
  expect(queue.finish(first.id, first.leaseToken, true, first.leaseUntil)).toBe(
    false,
  );
  expect(
    queue.finish(second.id, second.leaseToken, false, first.leaseUntil),
  ).toBe(true);
  expect(queue.runs().find((row) => row.id === second.id)?.state).toBe(
    "failed",
  );
  db.close();
});

test("heartbeat extends only a live lease and cannot revive an expired or superseded job", () => {
  const db = new Database(":memory:");
  const sql = {
    exec(query: string, ...args: unknown[]) {
      const rows = db.query(query).all(...(args as never[]));
      return { toArray: () => rows, one: () => rows[0] };
    },
  } as unknown as SqlStorage;
  db.run("CREATE TABLE refs (name TEXT PRIMARY KEY, oid TEXT NOT NULL)");
  db.run("INSERT INTO refs VALUES ('refs/heads/main', 'abc')");
  const queue = new CiQueue(sql);
  queue.enqueue("abc");
  const job = queue.claim("ci", 1000)!;
  expect(queue.heartbeat(job.id, "wrong", 2000)).toBe(false);
  expect(queue.heartbeat(job.id, job.leaseToken, 2000)).toBe(true);
  expect(queue.claim("ci", job.leaseUntil)).toBeNull();
  expect(queue.heartbeat(job.id, job.leaseToken, 902000)).toBe(false);
  const reclaimed = queue.claim("ci", 902000)!;
  queue.enqueue("def");
  expect(queue.heartbeat(reclaimed.id, reclaimed.leaseToken, 902001)).toBe(
    false,
  );
  db.close();
});

test("a single run carries its log and unknown ids are null", () => {
  const db = new Database(":memory:");
  const sql = {
    exec(query: string, ...args: unknown[]) {
      const rows = db.query(query).all(...(args as never[]));
      return { toArray: () => rows, one: () => rows[0] };
    },
  } as unknown as SqlStorage;
  db.run("CREATE TABLE refs (name TEXT PRIMARY KEY, oid TEXT NOT NULL)");
  db.run("INSERT INTO refs VALUES ('refs/heads/main', 'abc')");
  const queue = new CiQueue(sql);
  queue.enqueue("abc");
  const job = queue.claim("ci", 1000)!;
  queue.log(job.id, job.leaseToken, "$ bun install\n", 1001);
  expect(queue.run(job.id)).toMatchObject({
    id: job.id,
    state: "leased",
    log: "$ bun install\n",
  });
  expect(queue.run(999)).toBeNull();
  db.close();
});

function queueOn(db: Database) {
  const sql = {
    exec(query: string, ...args: unknown[]) {
      const rows = db.query(query).all(...(args as never[]));
      return { toArray: () => rows, one: () => rows[0] };
    },
  } as unknown as SqlStorage;
  db.run("CREATE TABLE refs (name TEXT PRIMARY KEY, oid TEXT NOT NULL)");
  db.run("INSERT INTO refs VALUES ('refs/heads/main', 'abc')");
  return new CiQueue(sql);
}

const states = (queue: CiQueue, kind: string) =>
  queue
    .runs()
    .filter((row) => row.kind === kind)
    .map((row) => `${row.commit_oid}:${row.state}`);

test("a passing CI run on main's head queues one deploy; failures do not", () => {
  const db = new Database(":memory:");
  const queue = queueOn(db);
  queue.enqueue("abc");
  const failing = queue.claim("ci", 1000)!;
  queue.finish(failing.id, failing.leaseToken, false, 1001);
  expect(states(queue, "deploy")).toEqual([]);
  queue.enqueue("abc");
  const passing = queue.claim("ci", 2000)!;
  queue.finish(passing.id, passing.leaseToken, true, 2001);
  expect(states(queue, "deploy")).toEqual(["abc:queued"]);
  const deploy = queue.claim("deploy", 2002)!;
  expect(deploy.commit).toBe("abc");
  expect(queue.claim("deploy", 2003)).toBeNull();
  queue.finish(deploy.id, deploy.leaseToken, true, 2004);
  expect(states(queue, "deploy")).toEqual(["abc:succeeded"]);
  db.close();
});

test("a CI pass for an old commit queues no deploy", () => {
  const db = new Database(":memory:");
  const queue = queueOn(db);
  queue.enqueue("abc");
  const job = queue.claim("ci", 1000)!;
  db.run("UPDATE refs SET oid = 'def' WHERE name = 'refs/heads/main'");
  queue.finish(job.id, job.leaseToken, true, 1001);
  expect(states(queue, "deploy")).toEqual([]);
  db.close();
});

test("a waiting deploy goes stale on a new head but a running one is kept", () => {
  const db = new Database(":memory:");
  const queue = queueOn(db);
  queue.enqueue("abc");
  const ci = queue.claim("ci", 1000)!;
  queue.finish(ci.id, ci.leaseToken, true, 1001);
  const running = queue.claim("deploy", 1002)!;
  db.run("UPDATE refs SET oid = 'def' WHERE name = 'refs/heads/main'");
  queue.enqueue("def");
  expect(queue.claim("deploy", 1003)).toBeNull();
  expect(queue.finish(running.id, running.leaseToken, true, 1004)).toBe(true);
  expect(states(queue, "deploy")).toEqual(["abc:succeeded"]);
  const next = queue.claim("ci", 1005)!;
  queue.finish(next.id, next.leaseToken, true, 1006);
  db.run("UPDATE refs SET oid = 'ghi' WHERE name = 'refs/heads/main'");
  expect(queue.claim("deploy", 1007)).toBeNull();
  expect(states(queue, "deploy")).toEqual(["def:superseded", "abc:succeeded"]);
  db.close();
});

test("only the newest backup waits, and it names the GitHub mirror", () => {
  const db = new Database(":memory:");
  const queue = queueOn(db);
  // Backups queued before runners could claim them, for commits long gone.
  for (const oid of ["old1", "old2"])
    db.run(
      "INSERT INTO ci_jobs (kind, commit_oid, state, created_at) VALUES ('backup', ?, 'queued', 0)",
      [oid],
    );
  queue.enqueue("abc");
  db.run("UPDATE refs SET oid = 'def' WHERE name = 'refs/heads/main'");
  queue.enqueue("def");
  const backup = queue.claim("backup", 1000)!;
  expect(backup).toMatchObject({ commit: "def", target: "oliynykmax/selfgit" });
  expect(queue.claim("backup", 1001)).toBeNull();
  db.run("UPDATE refs SET oid = 'ghi' WHERE name = 'refs/heads/main'");
  queue.enqueue("ghi");
  expect(queue.finish(backup.id, backup.leaseToken, true, 1002)).toBe(true);
  expect(states(queue, "backup")).toEqual([
    "ghi:queued",
    "def:succeeded",
    "abc:superseded",
    "old2:superseded",
    "old1:superseded",
  ]);
  db.close();
});
