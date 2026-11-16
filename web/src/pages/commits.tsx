import type { CommitPage, RepoName, RepoRefs } from "../../../src/api-types";
import { CommitRow } from "@/components/commit-row";
import { Link } from "@/components/link";
import { RefPicker } from "@/components/ref-picker";
import { LoadingRows, Problem } from "@/components/states";
import { buttonVariants } from "@/components/ui/button";
import { useApi } from "@/lib/api";
import { navigate, useLocation } from "@/lib/navigation";
import { apiUrl, href, splitRefPath } from "@/lib/route";
import { cn } from "@/lib/utils";

export function CommitsPage({ repo, refs, rest }: { repo: RepoName; refs: RepoRefs; rest: string[] }) {
  const { search } = useLocation();
  const page = Math.max(0, Number(new URLSearchParams(search).get("page")) || 0);
  const names = [...refs.branches, ...refs.tags].map((ref) => ref.name);
  const target = rest.length === 0 ? (refs.defaultBranch ? { ref: refs.defaultBranch, path: "" } : null) : splitRefPath(rest, names);
  const log = useApi<CommitPage>(target ? apiUrl(`repos/${repo}/commits`, { ref: target.ref, path: target.path, page }) : null);
  if (!target) return <Problem title={refs.defaultBranch ? "Branch or tag not found" : "No commits yet"} />;
  const base = href.commits(repo, target.ref, target.path);
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <RefPicker refs={refs} current={target.ref} onChange={(next) => navigate(href.commits(repo, next, target.path))} />
        {target.path ? (
          <p className="text-sm text-muted-foreground">
            History for{" "}
            <Link href={href.blob(repo, target.ref, target.path)} className="font-mono text-foreground hover:underline">
              {target.path}
            </Link>
          </p>
        ) : null}
      </div>
      <section className="overflow-hidden rounded-lg border" aria-label="Commits">
        {log.status === "loading" ? <LoadingRows rows={8} /> : null}
        {log.status === "error" ? <Problem title="Couldn't load commits" detail={log.message} /> : null}
        {log.status === "ok" ? (
          log.data.commits.length === 0 ? (
            <Problem title="No commits" />
          ) : (
            <ul className="divide-y text-sm">
              {log.data.commits.map((commit) => (
                <CommitRow key={commit.oid} repo={repo} commit={commit} />
              ))}
            </ul>
          )
        ) : null}
      </section>
      {log.status === "ok" && (page > 0 || log.data.nextPage !== null) ? (
        <nav aria-label="Pages" className="mt-4 flex justify-center gap-2">
          <Link href={page > 1 ? `${base}?page=${page - 1}` : base} aria-disabled={page === 0} className={cn(buttonVariants({ variant: "outline" }), page === 0 && "pointer-events-none opacity-50")}>
            Newer
          </Link>
          <Link
            href={`${base}?page=${log.data.nextPage ?? page}`}
            aria-disabled={log.data.nextPage === null}
            className={cn(buttonVariants({ variant: "outline" }), log.data.nextPage === null && "pointer-events-none opacity-50")}
          >
            Older
          </Link>
        </nav>
      ) : null}
    </div>
  );
}
