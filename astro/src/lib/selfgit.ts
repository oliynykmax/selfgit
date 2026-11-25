import type { RepoRefs, TreeView } from "../../../src/api-types";
import type { AsyncLocalStorage } from "node:async_hooks";

const ORIGIN = "https://git.oliinyk.dev";
type Backend = (request: Request) => Promise<Response>;
// The Worker runs Astro inside its own request, so repository data comes from calling its handler directly.
const backend = (
  globalThis as unknown as {
    __selfgitBackend?: AsyncLocalStorage<Backend>;
  }
).__selfgitBackend;

function encodePath(path: string): string {
  return path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

export function siteUrl(path: string): string {
  return new URL(path, ORIGIN).toString();
}

export function fetchSelfgit(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const call = backend?.getStore();
  if (!call) throw new Error("Astro rendered outside the selfgit Worker");
  return call(new Request(siteUrl(path), init));
}

export function repoUrl(repo: string): string {
  return `${ORIGIN}/${encodeURIComponent(repo)}`;
}

export function blobUrl(repo: string, oid: string, path: string): string {
  return `${ORIGIN}/${encodeURIComponent(repo)}/blob/${encodeURIComponent(oid)}/${encodePath(path)}`;
}

export function rawUrl(repo: string, oid: string, path: string): string {
  const query = new URLSearchParams({ ref: oid, path });
  return siteUrl(`/api/repos/${encodeURIComponent(repo)}/raw?${query}`);
}

export function treeUrl(repo: string, path = "", ref = "HEAD"): string {
  if (!path && ref === "HEAD") return `/${encodeURIComponent(repo)}`;
  return `/${encodeURIComponent(repo)}/tree/${encodePath(ref)}${path ? `/${encodePath(path)}` : ""}`;
}

export function parentPath(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

/** What a repository landing page shows. */
export type RepoView =
  | { kind: "tree"; tree: TreeView; refs: RepoRefs; duration: number }
  | { kind: "empty"; refs: RepoRefs }
  | { kind: "missing"; title: string; detail: string };

/** A 404 is an answer the page shows; any other failure is a server error. */
async function readApi(path: string): Promise<Response> {
  const response = await fetchSelfgit(path, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok && response.status !== 404)
    throw new Error(`Repository request failed (${response.status})`);
  return response;
}

export async function viewFor(repo: string, ref = "HEAD"): Promise<RepoView> {
  const name = encodeURIComponent(repo);
  const startedAt = performance.now();
  const [refsResponse, tree] = await Promise.all([
    readApi(`/api/repos/${name}`),
    readApi(`/api/repos/${name}/tree?${new URLSearchParams({ ref })}`).then(
      (response) => ({ response, duration: performance.now() - startedAt }),
    ),
  ]);
  if (refsResponse.status === 404)
    return {
      kind: "missing",
      title: "Repository not found",
      detail: `No repository named ${repo}.`,
    };
  const refs = (await refsResponse.json()) as RepoRefs;
  if (!refs.defaultBranch && ref === "HEAD") return { kind: "empty", refs };
  if (tree.response.status === 404)
    return { kind: "missing", title: "Branch or tag not found", detail: ref };
  return {
    kind: "tree",
    tree: (await tree.response.json()) as TreeView,
    refs,
    duration: tree.duration,
  };
}
