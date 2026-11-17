import { createHash } from "node:crypto";
import type { Browser } from "./browse";
import type { TreeView } from "./api-types";

export async function treeSnapshot(
  browser: Browser,
  bucket: R2Bucket,
  repoId: string,
  revision: string,
  path: string,
): Promise<TreeView> {
  const commit = browser.resolve(revision);
  const directory = path.split("/").filter(Boolean).join("/");
  const key = treeSnapshotKey(repoId, commit, directory);
  const cached = await bucket.get(key);
  if (cached) return cached.json<TreeView>();
  const view = await browser.treeView(commit, directory);
  await bucket.put(key, JSON.stringify(view));
  return view;
}

export function treeSnapshotKey(
  repoId: string,
  commit: string,
  path: string,
): string {
  const directory = path.split("/").filter(Boolean).join("/");
  const pathHash = createHash("sha256").update(directory).digest("hex");
  return `${repoId}/tree-snapshots/v1/${commit}/${pathHash}`;
}
