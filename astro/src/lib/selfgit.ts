import type { RepoRefs, TreeView } from "../../../src/api-types";

const ORIGIN = "https://git.oliinyk.dev";

function encodePath(path: string): string {
  return path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

export function siteUrl(path: string): string {
  return new URL(path, ORIGIN).toString();
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

export async function treeFor(
  repo: string,
  path: string,
  ref = "HEAD",
): Promise<{ tree: TreeView; duration: number }> {
  const params = new URLSearchParams({ ref });
  if (path) params.set("path", path);
  const startedAt = performance.now();
  const response = await fetch(
    siteUrl(`/api/repos/${encodeURIComponent(repo)}/tree?${params}`),
    { headers: { Accept: "application/json" } },
  );
  const duration = performance.now() - startedAt;
  if (!response.ok)
    throw new Error(`Repository request failed (${response.status})`);
  return { tree: (await response.json()) as TreeView, duration };
}

export async function viewFor(
  repo: string,
  path: string,
  ref = "HEAD",
): Promise<{ tree: TreeView; refs: RepoRefs; duration: number }> {
  const [treeResult, refs] = await Promise.all([
    treeFor(repo, path, ref),
    fetch(siteUrl(`/api/repos/${encodeURIComponent(repo)}`), {
      headers: { Accept: "application/json" },
    }).then(async (response) => {
      if (!response.ok)
        throw new Error(`Repository request failed (${response.status})`);
      return (await response.json()) as RepoRefs;
    }),
  ]);
  return { ...treeResult, refs };
}
