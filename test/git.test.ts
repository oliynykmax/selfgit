import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Subprocess, spawn, spawnSync } from "bun";

function ghOutput(...args: string[]): string {
  const result = spawnSync(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`gh ${args[0]} ${args[1]} failed; the push tests need a logged-in gh CLI`);
  return result.stdout.toString().trim();
}

const TOKEN = process.env.GH_TOKEN || ghOutput("auth", "token", "--hostname", "github.com");
const OWNER_ID = ghOutput("api", "user", "--jq", ".id");
const ROOT = join(import.meta.dir, "..");
const work = mkdtempSync(join(tmpdir(), "selfgit-test-"));
const state = join(work, "state");
const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
const GH_HELPER = '!f() { test "$1" = get && echo username=git && echo "password=$(gh auth token --hostname github.com)"; }; f';
let server: Subprocess | undefined;

const gitEnv = {
  ...process.env,
  HOME: work,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: join(work, "gitconfig"),
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Student",
  GIT_AUTHOR_EMAIL: "student@example.com",
  GIT_COMMITTER_NAME: "Student",
  GIT_COMMITTER_EMAIL: "student@example.com",
  GH_TOKEN: TOKEN,
};
writeFileSync(
  join(work, "gitconfig"),
  `[init]\n\tdefaultBranch = main\n[protocol]\n\tversion = 2\n[credential]\n\thelper = store\n[credential "${base}"]\n\thelper =\n\thelper = ${JSON.stringify(GH_HELPER)}\n`,
);

function git(cwd: string, ...args: string[]) {
  const result = spawnSync(["git", ...args], { cwd, env: gitEnv, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, out: result.stdout.toString().trim(), err: result.stderr.toString() };
}

function ok(cwd: string, ...args: string[]): string {
  const result = git(cwd, ...args);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed (${result.code}):\n${result.err}`);
  return result.out;
}

let dirCount = 0;
function dir(name: string): string {
  return join(work, `${name}-${dirCount++}`);
}

function newRepo(remote: string): string {
  const path = dir("src");
  ok(work, "init", "-q", path);
  ok(path, "remote", "add", "origin", `${base}/${remote}.git`);
  return path;
}

function commit(path: string, file: string, content: string | Uint8Array, message = `update ${file}`): string {
  writeFileSync(join(path, file), content);
  ok(path, "add", file);
  ok(path, "commit", "-q", "-m", message);
  return ok(path, "rev-parse", "HEAD");
}

function clone(remote: string, ...args: string[]): string {
  const path = dir("clone");
  ok(work, "clone", "-q", ...args, `${base}/${remote}.git`, path);
  return path;
}

async function startServer() {
  server = spawn(
    [join(ROOT, "node_modules/.bin/wrangler"), "dev", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", state, "--var", `GITHUB_OWNER_ID:${OWNER_ID}`, "--log-level", "warn"],
    { cwd: ROOT, stdout: "ignore", stderr: "pipe", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
  );
  for (let i = 0; i < 120; i++) {
    try {
      const response = await fetch(`${base}/`);
      if (response.status === 404) return;
    } catch {}
    await Bun.sleep(250);
  }
  throw new Error("wrangler dev did not start");
}

async function stopServer() {
  server?.kill("SIGTERM");
  await server?.exited;
  server = undefined;
}

beforeAll(startServer, 60_000);
afterAll(async () => {
  await stopServer();
  rmSync(work, { recursive: true, force: true });
});

describe("smart HTTP Git on a Durable Object", () => {
  test("clone of an empty repo, push, clone back, fsck", () => {
    const empty = clone("repo1");
    expect(ok(empty, "rev-list", "--all")).toBe("");

    const src = newRepo("repo1");
    commit(src, "README.md", "week 1\n");
    const head = commit(src, "a.txt", "assignment\n");
    ok(src, "push", "-q", "origin", "main");

    const copy = clone("repo1");
    expect(ok(copy, "rev-parse", "HEAD")).toBe(head);
    expect(ok(copy, "branch", "--show-current")).toBe("main");
    expect(readFileSync(join(copy, "a.txt"), "utf8")).toBe("assignment\n");
    ok(copy, "fsck", "--full", "--strict");
  });

  test("push requires the owner's GitHub token through the gh helper; reads stay public", async () => {
    const src = newRepo("repo2");
    commit(src, "f.txt", "x\n");
    const anonymous = git(src, "-c", `credential.${base}.helper=`, "push", "origin", "main");
    expect(anonymous.code).not.toBe(0);
    expect(anonymous.err).toMatch(/could not read Username/);
    const forged = git(src, "push", `http://git:gho_${randomBytes(18).toString("hex")}@127.0.0.1:${port}/repo2.git`, "main");
    expect(forged.code).not.toBe(0);
    expect(forged.err).toMatch(/Authentication failed/);
    expect(ok(work, "ls-remote", `${base}/repo2.git`)).toBe("");
    ok(src, "push", "-q", "origin", "main");
    expect(ok(work, "ls-remote", `${base}/repo2.git`, "refs/heads/main")).toContain("refs/heads/main");
    expect(existsSync(join(work, ".git-credentials"))).toBe(false);

    const advert = await fetch(`${base}/repo2.git/info/refs?service=git-receive-pack`);
    expect(advert.status).toBe(401);
    expect(advert.headers.get("WWW-Authenticate")).toContain("Basic");
    const read = await fetch(`${base}/repo2.git/info/refs?service=git-upload-pack`);
    expect(read.status).toBe(200);
    expect(read.headers.get("Content-Type")).toBe("application/x-git-upload-pack-advertisement");
  });

  test("incremental fetch, thin-pack pushes with deltas, force push, branches and tags", () => {
    const src = newRepo("repo3");
    const lines = Array.from({ length: 4000 }, (_, i) => `line ${i} ${"lorem ipsum ".repeat(4)}`);
    commit(src, "big.txt", `${lines.join("\n")}\n`);
    ok(src, "push", "-q", "origin", "main");
    const copy = clone("repo3");

    for (let round = 0; round < 5; round++) {
      lines[round * 500] = `changed in round ${round}`;
      commit(src, "big.txt", `${lines.join("\n")}\n`, `round ${round}`);
      ok(src, "push", "-q", "origin", "main");
    }
    ok(copy, "pull", "-q", "--ff-only");
    expect(ok(copy, "rev-parse", "HEAD")).toBe(ok(src, "rev-parse", "HEAD"));
    expect(readFileSync(join(copy, "big.txt"), "utf8")).toBe(`${lines.join("\n")}\n`);

    ok(src, "checkout", "-q", "-b", "feature");
    const feature = commit(src, "feature.txt", "feature\n");
    ok(src, "tag", "-a", "v1.0", "-m", "release");
    ok(src, "tag", "light");
    ok(src, "push", "-q", "origin", "feature", "--tags");
    const remote = ok(work, "ls-remote", `${base}/repo3.git`);
    expect(remote).toContain(`${feature}\trefs/tags/v1.0^{}`);
    expect(remote).toContain(`${feature}\trefs/tags/light`);
    expect(remote).toMatch(/^[0-9a-f]{40}\tHEAD$/m);

    ok(copy, "fetch", "-q", "origin");
    expect(ok(copy, "rev-parse", "origin/feature")).toBe(feature);
    expect(ok(copy, "cat-file", "-t", "v1.0")).toBe("tag");

    ok(src, "checkout", "-q", "main");
    ok(src, "reset", "-q", "--hard", "HEAD~2");
    const rewritten = commit(src, "rewrite.txt", "history rewritten\n");
    expect(git(src, "push", "origin", "main").code).not.toBe(0);
    ok(src, "push", "-q", "--force", "origin", "main");
    ok(copy, "fetch", "-q", "origin");
    expect(ok(copy, "rev-parse", "origin/main")).toBe(rewritten);

    ok(src, "push", "-q", "origin", "--delete", "feature", "light");
    const after = ok(work, "ls-remote", `${base}/repo3.git`);
    expect(after).not.toContain("refs/heads/feature");
    expect(after).not.toContain("refs/tags/light");
    ok(copy, "fsck", "--full");
  });

  test("large binary objects split across storage rows", () => {
    const src = newRepo("repo4");
    const big = randomBytes(5 * 1024 * 1024 + 123);
    commit(src, "data.bin", big);
    const edited = Buffer.from(big);
    edited.write("patched", 4096);
    commit(src, "data.bin", edited);
    ok(src, "push", "-q", "origin", "main");
    const copy = clone("repo4");
    expect(Buffer.compare(readFileSync(join(copy, "data.bin")), edited)).toBe(0);
    ok(copy, "checkout", "-q", "HEAD~1");
    expect(Buffer.compare(readFileSync(join(copy, "data.bin")), big)).toBe(0);
    ok(copy, "fsck", "--full");
  });

  test("shallow clone, deepen, unshallow, and tags match stock git-http-backend", async () => {
    const reference = spawn(["bun", join(import.meta.dir, "reference.ts"), join(work, "reference"), "repo5"], { stdout: "pipe" });
    try {
      const port = (await reference.stdout.getReader().read()).value;
      const referencePort = new TextDecoder().decode(port).trim();
      const src = newRepo("repo5");
      const referenceBase = `http://127.0.0.1:${referencePort}`;
      ok(src, "remote", "add", "reference", `${referenceBase}/repo5.git`);
      const commits = Array.from({ length: 6 }, (_, i) => commit(src, "n.txt", `${i}\n`));
      ok(src, "tag", "-a", "v0", "-m", "old", commits[1]!);
      ok(src, "branch", "old", commits[2]!);
      for (const remote of ["origin", "reference"]) ok(src, "push", "-q", remote, "main", "old", "--tags");

      const observe = (server: string) => {
        const seen: string[] = [];
        const look = (path: string) => {
          const shallowFile = join(path, ".git/shallow");
          const shallow = Bun.file(shallowFile).size > 0 ? readFileSync(shallowFile, "utf8").trim().split("\n").sort().join(",") : "";
          seen.push(`${ok(path, "rev-list", "--count", "--all")} shallow=[${shallow}] tags=[${ok(path, "tag").split("\n").join(",")}]`);
        };
        const path = dir("shallow");
        ok(work, "-c", "protocol.version=0", "clone", "-q", "--depth", "1", "--no-single-branch", `${server}/repo5.git`, path);
        look(path);
        ok(path, "-c", "protocol.version=0", "fetch", "-q", "--depth", "3", "origin", "main");
        look(path);
        ok(path, "-c", "protocol.version=0", "fetch", "-q", "--depth", "1", "origin", "old");
        look(path);
        ok(path, "-c", "protocol.version=0", "fetch", "-q", "--unshallow", "--tags", "origin");
        look(path);
        ok(path, "fsck", "--full");
        return seen;
      };

      const ours = observe(base);
      expect(ours).toEqual(observe(referenceBase));
      expect(ours.at(-1)).toBe("6 shallow=[] tags=[v0]");
    } finally {
      reference.kill();
    }
  });

  test("protocol v0 client and HEAD fallback to master", () => {
    const src = newRepo("repo6");
    ok(src, "checkout", "-q", "-b", "master");
    const head = commit(src, "m.txt", "master only\n");
    ok(src, "-c", "protocol.version=0", "push", "-q", "origin", "master");
    const path = dir("v0");
    ok(work, "-c", "protocol.version=0", "clone", "-q", `${base}/repo6.git`, path);
    expect(ok(path, "branch", "--show-current")).toBe("master");
    expect(ok(path, "rev-parse", "HEAD")).toBe(head);
  });

  test("receive-pack checks old values and honours atomic", async () => {
    const src = newRepo("repo7");
    const head = commit(src, "a.txt", "1\n");
    ok(src, "push", "-q", "origin", "main");
    const zero = "0".repeat(40);
    const stale = "1".repeat(40);
    const pkt = (line: string) => (Buffer.byteLength(line) + 4).toString(16).padStart(4, "0") + line;
    const emptyPack = Buffer.concat([Buffer.from("PACK\0\0\0\x02\0\0\0\0", "latin1")]);
    const pack = Buffer.concat([emptyPack, new Bun.CryptoHasher("sha1").update(emptyPack).digest()]);
    const send = async (commands: string, body: Buffer) => {
      const response = await fetch(`${base}/repo7.git/git-receive-pack`, {
        method: "POST",
        headers: { Authorization: `Basic ${btoa(`git:${TOKEN}`)}`, "Content-Type": "application/x-git-receive-pack-request" },
        body: Buffer.concat([Buffer.from(commands), body]),
      });
      expect(response.status).toBe(200);
      return response.text();
    };
    const push = (caps: string) =>
      send(`${pkt(`${zero} ${head} refs/heads/side\0${caps}\n`)}${pkt(`${stale} ${head} refs/heads/main\n`)}0000`, pack);

    const atomic = await push("report-status atomic");
    expect(atomic).toContain("unpack ok");
    expect(atomic).toContain("ng refs/heads/side atomic push failed");
    expect(atomic).toContain("ng refs/heads/main failed to update ref");
    expect(ok(work, "ls-remote", `${base}/repo7.git`)).not.toContain("refs/heads/side");

    const partial = await push("report-status");
    expect(partial).toContain("ok refs/heads/side");
    expect(partial).toContain("ng refs/heads/main failed to update ref");
    expect(ok(work, "ls-remote", `${base}/repo7.git`, "refs/heads/side")).toBe(`${head}\trefs/heads/side`);

    const orphan = commit(src, "d.txt", "tree never sent\n");
    const onlyCommit = spawnSync(["git", "pack-objects", "--stdout"], { cwd: src, env: gitEnv, stdin: Buffer.from(`${orphan}\n`) });
    const broken = await send(`${pkt(`${zero} ${orphan} refs/heads/broken\0report-status\n`)}0000`, Buffer.from(onlyCommit.stdout));
    expect(broken).toContain("unpack ok");
    expect(broken).toContain("ng refs/heads/broken missing necessary objects");
    expect(ok(work, "ls-remote", `${base}/repo7.git`)).not.toContain("refs/heads/broken");
    const retry = await send(`${pkt(`${zero} ${orphan} refs/heads/broken\0report-status\n`)}0000`, pack);
    expect(retry).toContain("ng refs/heads/broken missing necessary objects");
  });

  test("gzip request bodies, rejected wants, and unknown paths", async () => {
    const src = newRepo("repo8");
    const head = commit(src, "a.txt", "gzip\n");
    ok(src, "push", "-q", "origin", "main");
    const pkt = (line: string) => (line.length + 4).toString(16).padStart(4, "0") + line;
    const request = `${pkt(`want ${head} multi_ack_detailed side-band-64k\n`)}0000${pkt("done\n")}`;
    const response = await fetch(`${base}/repo8.git/git-upload-pack`, {
      method: "POST",
      headers: { "Content-Type": "application/x-git-upload-pack-request", "Content-Encoding": "gzip" },
      body: Bun.gzipSync(Buffer.from(request)),
    });
    expect(response.status).toBe(200);
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.subarray(0, 8).toString()).toBe("0008NAK\n");
    expect(body.includes(Buffer.from("PACK"))).toBe(true);

    const bogus = await fetch(`${base}/repo8.git/git-upload-pack`, {
      method: "POST",
      body: `${pkt(`want ${"1".repeat(40)} side-band-64k\n`)}0000${pkt("done\n")}`,
    });
    expect(await bogus.text()).toContain("not our ref");

    expect((await fetch(`${base}/repo11.git/info/refs?service=git-upload-pack`)).status).toBe(404);
    expect((await fetch(`${base}/repo1.git/info/refs`)).status).toBe(403);
    expect((await fetch(`${base}/repo1.git/git-upload-pack`)).status).toBe(405);
  });

  test("mirror transfer script copies every ref", () => {
    const source = join(work, "old-server.git");
    ok(work, "init", "-q", "--bare", source);
    const src = dir("legacy");
    ok(work, "init", "-q", src);
    commit(src, "x.txt", "legacy\n");
    ok(src, "checkout", "-q", "-b", "week2");
    commit(src, "y.txt", "week2\n");
    ok(src, "tag", "-a", "submitted", "-m", "done");
    ok(src, "push", "-q", "--mirror", source);

    const result = spawnSync(["sh", join(ROOT, "scripts/transfer.sh"), `file://${work}`, base], {
      env: { ...gitEnv, SELFGIT_REPOS: "old-server:repo9" },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    const strip = (refs: string) => refs.split("\n").filter((line) => !line.endsWith("\tHEAD")).join("\n");
    expect(strip(ok(work, "ls-remote", `${base}/repo9.git`))).toBe(strip(ok(work, "ls-remote", source)));
  });

  test("data survives a restart of the local runtime", async () => {
    const before = ok(work, "ls-remote", `${base}/repo3.git`);
    await stopServer();
    await startServer();
    expect(ok(work, "ls-remote", `${base}/repo3.git`)).toBe(before);
    const copy = clone("repo4");
    ok(copy, "fsck", "--full");
  }, 60_000);
});
