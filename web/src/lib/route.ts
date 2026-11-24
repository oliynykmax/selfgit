import {
  isRepoName,
  PIPELINE_REPO,
  type RepoName,
} from "../../../src/api-types";

export type RepoTab =
  "code" | "commits" | "branches" | "tags" | "actions" | "settings";

export type Route =
  | { kind: "home" }
  | { kind: "tree"; repo: RepoName; rest: string[] }
  | { kind: "blob"; repo: RepoName; rest: string[] }
  | { kind: "commits"; repo: RepoName; rest: string[] }
  | { kind: "commit"; repo: RepoName; oid: string }
  | { kind: "branches"; repo: RepoName }
  | { kind: "tags"; repo: RepoName }
  | { kind: "settings"; repo: RepoName }
  | { kind: "actions"; repo: RepoName }
  | { kind: "run"; repo: RepoName; id: number }
  | { kind: "not-found" };

const OID = /^[0-9a-f]{40}$/;

export function parseRoute(pathname: string): Route {
  const parts = pathname
    .split("/")
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
  if (parts.length === 0) return { kind: "home" };
  const [repo, section, ...rest] = parts;
  if (!repo || !isRepoName(repo)) return { kind: "not-found" };
  switch (section) {
    case undefined:
      return { kind: "tree", repo, rest: [] };
    case "tree":
    case "blob":
    case "commits":
      return { kind: section, repo, rest };
    case "commit":
      return rest.length === 1 && OID.test(rest[0]!)
        ? { kind: "commit", repo, oid: rest[0]! }
        : { kind: "not-found" };
    case "branches":
    case "tags":
    case "settings":
      return rest.length === 0
        ? { kind: section, repo }
        : { kind: "not-found" };
    case "actions":
      if (repo !== PIPELINE_REPO || rest.length > 1)
        return { kind: "not-found" };
      if (rest.length === 0) return { kind: "actions", repo };
      return /^[1-9][0-9]{0,15}$/.test(rest[0]!)
        ? { kind: "run", repo, id: Number(rest[0]) }
        : { kind: "not-found" };
    default:
      return { kind: "not-found" };
  }
}

export function tabOf(route: Route): RepoTab | null {
  switch (route.kind) {
    case "tree":
    case "blob":
      return "code";
    case "commits":
    case "commit":
      return "commits";
    case "branches":
      return "branches";
    case "tags":
      return "tags";
    case "settings":
      return "settings";
    case "actions":
    case "run":
      return "actions";
    default:
      return null;
  }
}

/**
 * Ref names can contain slashes, so `/tree/a/b/c` is split by the longest ref the repo has,
 * the way GitHub reads these URLs. A full commit id works as a ref too.
 */
export function splitRefPath(
  rest: string[],
  refNames: string[],
): { ref: string; path: string } | null {
  if (rest.length === 0) return null;
  const joined = rest.join("/");
  const match = [...refNames]
    .sort((a, b) => b.length - a.length)
    .find((name) => joined === name || joined.startsWith(`${name}/`));
  if (match) return { ref: match, path: joined.slice(match.length + 1) };
  if (OID.test(rest[0]!))
    return { ref: rest[0]!, path: rest.slice(1).join("/") };
  return null;
}

function encodePath(value: string): string {
  return value.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

function join(...parts: string[]): string {
  return `/${parts.filter(Boolean).join("/")}`;
}

export const href = {
  repo: (repo: RepoName) => `/${repo}`,
  tree: (repo: RepoName, ref: string, path = "") =>
    join(repo, "tree", encodePath(ref), encodePath(path)),
  blob: (repo: RepoName, ref: string, path: string) =>
    join(repo, "blob", encodePath(ref), encodePath(path)),
  commits: (repo: RepoName, ref: string, path = "") =>
    join(repo, "commits", encodePath(ref), encodePath(path)),
  commit: (repo: RepoName, oid: string) => join(repo, "commit", oid),
  branches: (repo: RepoName) => join(repo, "branches"),
  tags: (repo: RepoName) => join(repo, "tags"),
  settings: (repo: RepoName) => join(repo, "settings"),
  actions: (repo: RepoName) => join(repo, "actions"),
  run: (repo: RepoName, id: number) => join(repo, "actions", String(id)),
};

export function apiUrl(
  path: string,
  params: Record<string, string | number | undefined> = {},
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value !== undefined && value !== "") search.set(key, String(value));
  const query = search.toString();
  return `/api/${path}${query ? `?${query}` : ""}`;
}
