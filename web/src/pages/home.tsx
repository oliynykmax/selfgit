import type { RepoSummary } from "../../../src/api-types";
import { Link } from "@/components/link";
import { LoadingRows, Problem } from "@/components/states";
import { Time } from "@/components/time";
import { useApi } from "@/lib/api";
import { plural } from "@/lib/format";
import { href } from "@/lib/route";

export function Home() {
  const repos = useApi<RepoSummary[]>("/api/repos");
  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Repositories</h1>
      <div className="mt-5 overflow-hidden rounded-lg border">
        {repos.status === "loading" ? <LoadingRows rows={10} /> : null}
        {repos.status === "error" ? <Problem title="Couldn't load repositories" detail={repos.message} /> : null}
        {repos.status === "ok" ? (
          <ul className="divide-y">
            {repos.data.map((repo) => (
              <li key={repo.name}>
                <Link href={href.repo(repo.name)} className="flex flex-col gap-1 px-4 py-3 hover:bg-muted/50 sm:flex-row sm:items-center sm:gap-4">
                  <span className="w-24 shrink-0 font-medium">{repo.name}</span>
                  {repo.lastCommit ? (
                    <>
                      <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{repo.lastCommit.subject}</span>
                      <span className="flex shrink-0 gap-3 text-xs text-muted-foreground">
                        <span>{plural(repo.branchCount, "branch", "branches")}</span>
                        <Time seconds={repo.lastCommit.committer.time} />
                      </span>
                    </>
                  ) : (
                    <span className="flex-1 text-sm text-muted-foreground">Empty</span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </main>
  );
}
