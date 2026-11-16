import type { CommitSummary, RepoName } from "../../../src/api-types";
import { Link } from "@/components/link";
import { Time } from "@/components/time";
import { shortOid } from "@/lib/format";
import { href } from "@/lib/route";

export function CommitRow({ repo, commit }: { repo: RepoName; commit: CommitSummary }) {
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <Link href={href.commit(repo, commit.oid)} className="line-clamp-2 font-medium hover:underline">
          {commit.subject || "(no message)"}
        </Link>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {commit.author.name} committed <Time seconds={commit.committer.time} />
        </p>
      </div>
      <Link href={href.commit(repo, commit.oid)} className="shrink-0 rounded-md border px-1.5 py-0.5 font-mono text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
        {shortOid(commit.oid)}
      </Link>
    </li>
  );
}
