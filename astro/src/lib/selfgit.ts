import type { TreeView } from "../../../src/api-types";

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

export function treeUrl(repo: string, path = ""): string {
  return `/${encodeURIComponent(repo)}${path ? `/${encodePath(path)}` : ""}`;
}

export function parentPath(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

export async function treeFor(
  repo: string,
  path: string,
): Promise<{ tree: TreeView; duration: number }> {
  const params = new URLSearchParams({ ref: "HEAD" });
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
