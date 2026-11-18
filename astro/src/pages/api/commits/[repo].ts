import type { APIRoute } from "astro";
import type { CommitPage } from "../../../../../src/api-types";
import { fetchSelfgit, repoUrl } from "../../../lib/selfgit";

export const GET: APIRoute = async ({ params, url }) => {
  const repo = params.repo;
  const ref = url.searchParams.get("ref");
  if (!repo || !ref) return new Response("Not found", { status: 404 });
  const response = await fetchSelfgit(
    `/api/repos/${encodeURIComponent(repo)}/commits?ref=${encodeURIComponent(ref)}`,
    { headers: { Accept: "application/json" } },
  );
  if (!response.ok)
    return new Response("Could not load commits", { status: response.status });
  const page = (await response.json()) as CommitPage;
  return Response.json({
    commits: page.commits.map((commit) => ({
      ...commit,
      url: `${repoUrl(repo)}/commit/${commit.oid}`,
    })),
  });
};
