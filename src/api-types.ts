export type RepoName = string;

export function isRepoName(value: string): value is RepoName {
  return (
    /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9_-])?$/.test(value) &&
    !value.endsWith(".git") &&
    !["api", "auth", "assets", "favicon.ico"].includes(value)
  );
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
  /** Free text the owner set in Settings; empty when unset. */
  description: string;
  branches: RefSummary[];
  tags: RefSummary[];
}

export interface RepoSettings {
  name: RepoName;
  /** The branch HEAD points at now, whether configured or the main, master, first-branch fallback. */
  defaultBranch: string | null;
  /** Short names of every branch, the choices for the default branch. */
  branches: string[];
  description: string;
  /** False for the pipeline repository. */
  canDelete: boolean;
}

/** What the owner may change; each field is optional. */
export interface SettingsPatch {
  defaultBranch?: string;
  description?: string;
}

export const DESCRIPTION_LIMIT = 280;

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

export type Session =
  | { authenticated: false }
  | { authenticated: true; login: string; avatarUrl: string };

export interface ApiError {
  error: string;
}

/** The repository whose pushes to main run CI, and so the only one with an Actions tab. */
export const PIPELINE_REPO = "selfgit";

export type CiState =
  "queued" | "leased" | "succeeded" | "failed" | "superseded";

export interface CiRun {
  id: number;
  kind: "ci" | "backup" | "deploy";
  commit_oid: string;
  state: CiState;
  /** Unix milliseconds. */
  created_at: number;
  finished_at: number | null;
}

export interface CiRunDetail extends CiRun {
  /** The last 64 KB of sanitized runner output. */
  log: string;
}
