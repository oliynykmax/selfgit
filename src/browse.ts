import { Buffer } from "node:buffer";
import { structuredPatch } from "diff";
import type {
  BlobContent,
  BlobView,
  CommitDetail,
  CommitPage,
  CommitSummary,
  CommitView,
  DiffHunk,
  DiffLine,
  EntryKind,
  FileDiff,
  FileStatus,
  Readme,
  RefSummary,
  RepoName,
  RepoRefs,
  RepoSummary,
  Signature,
  TreeEntry,
  TreeView,
} from "./api-types";
import { isOid, type ObjectStore } from "./objects";
import { headTarget } from "./protocol";

export const PAGE_SIZE = 30;
const VIEW_LIMIT = 1 << 20;
const RAW_LIMIT = 25 << 20;
const DIFF_FILE_LIMIT = 512 << 10;
const DIFF_FILES = 300;
const DIFF_LINES = 20_000;
const HISTORY_LIMIT = 2_000;

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
};

export class NotFound extends Error {}

interface RawEntry {
  mode: string;
  name: string;
  oid: string;
}

function entryKind(mode: string): EntryKind {
  if (mode === "40000") return "tree";
  if (mode === "160000") return "submodule";
  if (mode === "120000") return "symlink";
  return "blob";
}

function parseSignature(value: string): Signature {
  const match = /^(.*?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(value);
  if (!match) return { name: value, email: "", time: 0, tz: "+0000" };
  return { name: match[1]!, email: match[2]!, time: Number(match[3]), tz: match[4]! };
}

export function parseCommit(oid: string, content: Buffer): CommitDetail {
  const text = content.toString("utf8");
  const split = text.indexOf("\n\n");
  const headers = (split === -1 ? text : text.slice(0, split)).split("\n");
  const message = split === -1 ? "" : text.slice(split + 2);
  let tree = "";
  const parents: string[] = [];
  let author = parseSignature("");
  let committer = author;
  for (const line of headers) {
    const space = line.indexOf(" ");
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === "tree") tree = value;
    else if (key === "parent") parents.push(value);
    else if (key === "author") author = parseSignature(value);
    else if (key === "committer") committer = parseSignature(value);
  }
  const newline = message.indexOf("\n");
  const subject = (newline === -1 ? message : message.slice(0, newline)).trim();
  const body = newline === -1 ? "" : message.slice(newline + 1).trim();
  return { oid, tree, parents, author, committer, subject, body };
}

function summary(commit: CommitDetail): CommitSummary {
  const { oid, parents, author, committer, subject } = commit;
  return { oid, parents, author, committer, subject };
}

function looksBinary(content: Buffer): boolean {
  return content.subarray(0, 8000).includes(0);
}

function extension(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function imageType(path: string): string | null {
  return IMAGE_TYPES[extension(path)] ?? null;
}

function splitPath(path: string): string[] {
  return path.split("/").filter((part) => part !== "");
}

/** Reads objects for one request, caching parsed commits and trees so history walks stay cheap. */
export class Browser {
  private readonly commits = new Map<string, CommitDetail>();
  private readonly trees = new Map<string, RawEntry[]>();
  private readonly dirs = new Map<string, Map<string, string>>();

  constructor(private readonly store: ObjectStore) {}

  commit(oid: string): CommitDetail {
    const cached = this.commits.get(oid);
    if (cached) return cached;
    const object = this.store.read(oid);
    if (object?.type !== "commit") throw new NotFound(`no commit ${oid}`);
    const commit = parseCommit(oid, object.content);
    this.commits.set(oid, commit);
    return commit;
  }

  private tree(oid: string): RawEntry[] {
    const cached = this.trees.get(oid);
    if (cached) return cached;
    const object = this.store.read(oid);
    if (object?.type !== "tree") throw new NotFound(`no tree ${oid}`);
    const entries: RawEntry[] = [];
    const content = object.content;
    let pos = 0;
    while (pos < content.length) {
      const space = content.indexOf(0x20, pos);
      const nul = content.indexOf(0, space + 1);
      entries.push({
        mode: content.toString("latin1", pos, space),
        name: content.toString("utf8", space + 1, nul),
        oid: content.toString("hex", nul + 1, nul + 21),
      });
      pos = nul + 21;
    }
    this.trees.set(oid, entries);
    return entries;
  }

  /** The entry at `path` inside the commit's tree, the root tree for "", or null when absent. */
  private lookup(commitOid: string, path: string): RawEntry | null {
    let entry: RawEntry = { mode: "40000", name: "", oid: this.commit(commitOid).tree };
    for (const part of splitPath(path)) {
      if (entry.mode !== "40000") return null;
      const next = this.tree(entry.oid).find((candidate) => candidate.name === part);
      if (!next) return null;
      entry = next;
    }
    return entry;
  }

  private children(commitOid: string, path: string): Map<string, string> {
    const key = `${commitOid}:${path}`;
    const cached = this.dirs.get(key);
    if (cached) return cached;
    const entry = this.lookup(commitOid, path);
    const children = new Map(entry?.mode === "40000" ? this.tree(entry.oid).map((child) => [child.name, `${child.mode} ${child.oid}`]) : []);
    this.dirs.set(key, children);
    return children;
  }

  /** Resolves a branch, tag, full ref name or commit id to a commit id. */
  resolve(revision: string): string {
    const refs = this.store.refs();
    const candidates = revision === "HEAD" ? [headTarget(refs)] : [revision, `refs/heads/${revision}`, `refs/tags/${revision}`];
    for (const name of candidates) {
      const oid = name.startsWith("refs/") ? refs.get(name) : undefined;
      if (oid) return this.peelToCommit(oid);
    }
    if (isOid(revision) && this.store.info(revision)?.type === "commit") return revision;
    throw new NotFound(`unknown revision ${revision}`);
  }

  private peelToCommit(oid: string): string {
    const peeled = this.store.peel(oid);
    if (this.store.info(peeled)?.type !== "commit") throw new NotFound("ref does not point at a commit");
    return peeled;
  }

  refs(name: RepoName): RepoRefs {
    const refs = this.store.refs();
    const branches: RefSummary[] = [];
    const tags: RefSummary[] = [];
    for (const [ref, oid] of refs) {
      const peeled = this.store.peel(oid);
      if (this.store.info(peeled)?.type !== "commit") continue;
      const entry = { name: ref.replace(/^refs\/(heads|tags)\//, ""), commit: summary(this.commit(peeled)) };
      if (ref.startsWith("refs/heads/")) branches.push(entry);
      else if (ref.startsWith("refs/tags/")) tags.push(entry);
    }
    const newest = (a: RefSummary, b: RefSummary) => b.commit.committer.time - a.commit.committer.time;
    branches.sort(newest);
    tags.sort(newest);
    const head = headTarget(refs);
    return { name, defaultBranch: refs.has(head) ? head.slice("refs/heads/".length) : null, branches, tags };
  }

  summary(name: RepoName): RepoSummary {
    const { defaultBranch, branches, tags } = this.refs(name);
    const head = branches.find((branch) => branch.name === defaultBranch);
    return { name, defaultBranch, branchCount: branches.length, tagCount: tags.length, lastCommit: head?.commit ?? null };
  }

  /**
   * Walks history newest first, like `git log -- <path>`: a commit is shown when it changed what `key` reads,
   * and when it matches one parent only that parent is followed.
   */
  private *history(start: string, key: (commit: string) => string): Generator<CommitDetail> {
    const queue = [this.commit(start)];
    const seen = new Set([start]);
    let visited = 0;
    while (queue.length > 0 && visited++ < HISTORY_LIMIT) {
      queue.sort((a, b) => b.committer.time - a.committer.time);
      const commit = queue.shift()!;
      const mine = key(commit.oid);
      const same = commit.parents.find((parent) => key(parent) === mine);
      if (same === undefined && !(commit.parents.length === 0 && mine === "")) yield commit;
      for (const parent of same === undefined ? commit.parents : [same]) {
        if (seen.has(parent)) continue;
        seen.add(parent);
        queue.push(this.commit(parent));
      }
    }
  }

  log(revision: string, path: string, page: number): CommitPage {
    const start = this.resolve(revision);
    const clean = splitPath(path).join("/");
    const key = clean === "" ? (oid: string) => oid : (oid: string) => {
      const entry = this.lookup(oid, clean);
      return entry ? `${entry.mode} ${entry.oid}` : "";
    };
    const commits: CommitSummary[] = [];
    let index = 0;
    for (const commit of this.history(start, key)) {
      if (index++ < page * PAGE_SIZE) continue;
      if (commits.length === PAGE_SIZE) return { commits, nextPage: page + 1 };
      commits.push(summary(commit));
    }
    return { commits, nextPage: null };
  }

  private lastCommits(start: string, path: string, names: string[]): Map<string, CommitSummary> {
    const found = new Map<string, CommitSummary>();
    const pending = new Set(names);
    const key = (oid: string) => {
      const children = this.children(oid, path);
      return [...pending].map((name) => children.get(name) ?? "").join("\n");
    };
    for (const commit of this.history(start, key)) {
      const children = this.children(commit.oid, path);
      const parents = commit.parents.map((parent) => this.children(parent, path));
      for (const name of [...pending]) {
        const mine = children.get(name);
        if (parents.every((parent) => parent.get(name) !== mine)) {
          found.set(name, summary(commit));
          pending.delete(name);
        }
      }
      if (pending.size === 0) break;
    }
    return found;
  }

  treeView(revision: string, path: string): TreeView {
    const start = this.resolve(revision);
    const clean = splitPath(path).join("/");
    const entry = this.lookup(start, clean);
    if (entry?.mode !== "40000") throw new NotFound(`no directory ${clean}`);
    const raw = this.tree(entry.oid);
    const last = this.lastCommits(start, clean, raw.map((child) => child.name));
    const entries: TreeEntry[] = raw
      .map((child) => ({
        name: child.name,
        path: clean === "" ? child.name : `${clean}/${child.name}`,
        kind: entryKind(child.mode),
        oid: child.oid,
        lastCommit: last.get(child.name) ?? null,
      }))
      .sort((a, b) => Number(b.kind === "tree") - Number(a.kind === "tree") || a.name.localeCompare(b.name));
    return { commit: summary(this.commit(start)), path: clean, entries, readme: this.readme(raw, clean) };
  }

  private readme(entries: RawEntry[], dir: string): Readme | null {
    const candidates = entries.filter((entry) => entryKind(entry.mode) === "blob" && /^readme(\.(md|markdown|txt))?$/i.test(entry.name));
    const pick = candidates.find((entry) => /\.(md|markdown)$/i.test(entry.name)) ?? candidates[0];
    if (!pick) return null;
    const object = this.store.read(pick.oid);
    if (!object || object.content.length > VIEW_LIMIT || looksBinary(object.content)) return null;
    return {
      path: dir === "" ? pick.name : `${dir}/${pick.name}`,
      markdown: /\.(md|markdown)$/i.test(pick.name),
      text: object.content.toString("utf8"),
    };
  }

  private blobAt(revision: string, path: string): { commit: string; entry: RawEntry; content: Buffer } {
    const commit = this.resolve(revision);
    const entry = this.lookup(commit, splitPath(path).join("/"));
    if (!entry || entry.mode === "40000" || entry.mode === "160000") throw new NotFound(`no file ${path}`);
    const object = this.store.read(entry.oid);
    if (object?.type !== "blob") throw new NotFound(`no file ${path}`);
    return { commit, entry, content: object.content };
  }

  blobView(revision: string, path: string): BlobView {
    const { commit, entry, content } = this.blobAt(revision, path);
    const mime = imageType(path);
    let view: BlobContent;
    if (entry.mode === "120000") view = { kind: "text", text: content.toString("utf8") };
    else if (mime) view = { kind: "image", mime };
    else if (looksBinary(content)) view = { kind: "binary" };
    else if (content.length > VIEW_LIMIT) view = { kind: "too-large" };
    else view = { kind: "text", text: content.toString("utf8") };
    return { commit: summary(this.commit(commit)), path: splitPath(path).join("/"), oid: entry.oid, size: content.length, content: view };
  }

  raw(revision: string, path: string): { content: Uint8Array; binary: boolean } | "too-large" {
    const { content } = this.blobAt(revision, path);
    if (content.length > RAW_LIMIT) return "too-large";
    return { content: new Uint8Array(content), binary: looksBinary(content) };
  }

  commitView(oid: string): CommitView {
    if (!isOid(oid)) throw new NotFound(`not a commit id: ${oid}`);
    const commit = this.commit(oid);
    const parent = commit.parents[0];
    const changes: { path: string; before: RawEntry | null; after: RawEntry | null }[] = [];
    this.diffTrees(parent ? this.commit(parent).tree : null, commit.tree, "", changes);
    let budget = DIFF_LINES;
    const files = changes.slice(0, DIFF_FILES).map((change) => {
      const file = this.fileDiff(change.path, change.before, change.after, budget);
      budget -= file.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
      return file;
    });
    return { commit, files, truncated: changes.length > DIFF_FILES };
  }

  private diffTrees(before: string | null, after: string | null, prefix: string, out: { path: string; before: RawEntry | null; after: RawEntry | null }[]): void {
    if (before === after) return;
    const left = new Map((before ? this.tree(before) : []).map((entry) => [entry.name, entry]));
    const right = new Map((after ? this.tree(after) : []).map((entry) => [entry.name, entry]));
    const names = [...new Set([...left.keys(), ...right.keys()])].sort();
    for (const name of names) {
      const a = left.get(name) ?? null;
      const b = right.get(name) ?? null;
      if (a && b && a.oid === b.oid && a.mode === b.mode) continue;
      const path = `${prefix}${name}`;
      const aTree = a?.mode === "40000" ? a.oid : null;
      const bTree = b?.mode === "40000" ? b.oid : null;
      if (aTree || bTree) this.diffTrees(aTree, bTree, `${path}/`, out);
      const aFile = a && a.mode !== "40000" ? a : null;
      const bFile = b && b.mode !== "40000" ? b : null;
      if (aFile || bFile) out.push({ path, before: aFile, after: bFile });
    }
  }

  private fileText(entry: RawEntry | null): Buffer | null | "submodule" {
    if (!entry) return null;
    if (entry.mode === "160000") return "submodule";
    return this.store.read(entry.oid)?.content ?? Buffer.alloc(0);
  }

  private fileDiff(path: string, before: RawEntry | null, after: RawEntry | null, budget: number): FileDiff {
    const status: FileStatus = !before ? "added" : !after ? "deleted" : before.mode !== after.mode && (before.mode === "120000" || after.mode === "120000" || before.mode === "160000" || after.mode === "160000") ? "type-changed" : "modified";
    const a = this.fileText(before);
    const b = this.fileText(after);
    const text = (side: Buffer | null | "submodule", entry: RawEntry | null) =>
      side === null ? "" : side === "submodule" ? `Subproject commit ${entry!.oid}\n` : side.toString("utf8");
    const binary = [a, b].some((side) => side instanceof Buffer && looksBinary(side));
    const large = [a, b].some((side) => side instanceof Buffer && side.length > DIFF_FILE_LIMIT);
    if (binary || large) return { path, status, additions: 0, deletions: 0, omitted: binary ? "binary" : "too-large", hunks: [] };
    const patch = structuredPatch(path, path, text(a, before), text(b, after), undefined, undefined, { context: 3 });
    let additions = 0;
    let deletions = 0;
    const hunks: DiffHunk[] = patch.hunks.map((hunk) => {
      let oldLine = hunk.oldStart;
      let newLine = hunk.newStart;
      const lines: DiffLine[] = [];
      for (const line of hunk.lines) {
        const mark = line[0];
        const body = line.slice(1);
        if (mark === "+") {
          additions++;
          lines.push({ kind: "add", text: body, oldLine: null, newLine: newLine++ });
        } else if (mark === "-") {
          deletions++;
          lines.push({ kind: "del", text: body, oldLine: oldLine++, newLine: null });
        } else if (mark === " ") {
          lines.push({ kind: "context", text: body, oldLine: oldLine++, newLine: newLine++ });
        }
      }
      return { header: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, lines };
    });
    const size = hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
    if (size > budget) return { path, status, additions, deletions, omitted: "too-large", hunks: [] };
    return { path, status, additions, deletions, omitted: null, hunks };
  }
}
