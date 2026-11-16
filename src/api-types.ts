export const REPO_NAMES = ["repo1", "repo2", "repo3", "repo4", "repo5", "repo6", "repo7", "repo8", "repo9", "repo10"] as const;
export type RepoName = (typeof REPO_NAMES)[number];

export function isRepoName(value: string): value is RepoName {
  return (REPO_NAMES as readonly string[]).includes(value);
}

export interface Signature {
  name: string;
  email: string;
  /** Unix seconds. */
  time: number;
  /** As Git writes it, like "+0200". */
  tz: string;
}

export interface CommitSummary {
  oid: string;
  parents: string[];
  author: Signature;
  committer: Signature;
  subject: string;
}

export interface CommitDetail extends CommitSummary {
  tree: string;
  /** The message after the subject line, trimmed. */
  body: string;
}

export interface RefSummary {
  /** Short name, like "main" or "v1.0". */
  name: string;
  /** The commit the ref points at, after peeling tags. */
  commit: CommitSummary;
}

export interface RepoSummary {
  name: RepoName;
  defaultBranch: string | null;
  branchCount: number;
  tagCount: number;
  lastCommit: CommitSummary | null;
}

export interface RepoRefs {
  name: RepoName;
  defaultBranch: string | null;
  branches: RefSummary[];
  tags: RefSummary[];
}

export type EntryKind = "tree" | "blob" | "symlink" | "submodule";

export interface TreeEntry {
  name: string;
  path: string;
  kind: EntryKind;
  oid: string;
  /** The newest commit that changed this entry, when found within the history walk limit. */
  lastCommit: CommitSummary | null;
}

export interface Readme {
  path: string;
  markdown: boolean;
  text: string;
}

export interface TreeView {
  commit: CommitSummary;
  path: string;
  entries: TreeEntry[];
  readme: Readme | null;
}

export type BlobContent =
  | { kind: "text"; text: string }
  | { kind: "image"; mime: string }
  | { kind: "binary" }
  | { kind: "too-large" };

export interface BlobView {
  commit: CommitSummary;
  path: string;
  oid: string;
  size: number;
  content: BlobContent;
}

export interface CommitPage {
  commits: CommitSummary[];
  /** The `page` to request next, or null at the root commit. */
  nextPage: number | null;
}

export type FileStatus = "added" | "deleted" | "modified" | "type-changed";

export interface DiffLine {
  kind: "context" | "add" | "del";
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  /** Why no hunks are shown, when they aren't. */
  omitted: "binary" | "too-large" | null;
  hunks: DiffHunk[];
}

export interface CommitView {
  commit: CommitDetail;
  files: FileDiff[];
  /** True when the commit changed more files than the page shows. */
  truncated: boolean;
}

export type Session = { authenticated: false } | { authenticated: true; login: string; avatarUrl: string };

export interface ApiError {
  error: string;
}
