import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { CiQueue } from "../src/ci";

test("expired leases are reclaimed and cannot write or finish", () => {
  const db = new Database(":memory:");
  const sql = { exec(query: string, ...args: unknown[]) {
    const rows = db.query(query).all(...args as never[]);
    return { toArray: () => rows, one: () => rows[0] };
  } } as unknown as SqlStorage;
  db.run("CREATE TABLE refs (name TEXT PRIMARY KEY, oid TEXT NOT NULL)");
  db.run("INSERT INTO refs VALUES ('refs/heads/main', 'abc')");
  const queue = new CiQueue(sql);
  queue.enqueue("abc");
  const first = queue.claim("ci", 1000)!;
  expect(queue.claim("ci", 1001)).toBeNull();
  const second = queue.claim("ci", first.leaseUntil)!;
  expect(second.id).toBe(first.id);
  expect(second.leaseToken).not.toBe(first.leaseToken);
  expect(queue.log(first.id, first.leaseToken, "late", first.leaseUntil)).toBe(false);
  expect(queue.finish(first.id, first.leaseToken, true, first.leaseUntil)).toBe(false);
  expect(queue.finish(second.id, second.leaseToken, false, first.leaseUntil)).toBe(true);
  expect(queue.runs().find((row) => row.id === second.id)?.state).toBe("failed");
  db.close();
});

test("heartbeat extends only a live lease and cannot revive an expired or superseded job", () => {
  const db = new Database(":memory:");
  const sql = { exec(query: string, ...args: unknown[]) {
    const rows = db.query(query).all(...args as never[]);
    return { toArray: () => rows, one: () => rows[0] };
  } } as unknown as SqlStorage;
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
  expect(queue.heartbeat(reclaimed.id, reclaimed.leaseToken, 902001)).toBe(false);
  db.close();
});
