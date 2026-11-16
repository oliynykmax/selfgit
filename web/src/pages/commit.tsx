import { ChevronDown } from "lucide-react";
import type { CommitView, DiffLine, FileDiff, RepoName } from "../../../src/api-types";
import { Link } from "@/components/link";
import { LoadingRows, Problem } from "@/components/states";
import { Time } from "@/components/time";
import { useApi } from "@/lib/api";
import { fullDate, plural, shortOid } from "@/lib/format";
import { apiUrl, href } from "@/lib/route";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<FileDiff["status"], string> = { added: "added", deleted: "deleted", modified: "modified", "type-changed": "type changed" };

const LINE_STYLE: Record<DiffLine["kind"], string> = {
  context: "",
  add: "bg-added-muted",
  del: "bg-removed-muted",
};

function Counts({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="flex shrink-0 gap-1.5 font-mono text-xs">
      <span className="text-added">+{additions}</span>
      <span className="text-removed">-{deletions}</span>
    </span>
  );
}

function FileCard({ repo, commit, file }: { repo: RepoName; commit: string; file: FileDiff }) {
  return (
    <details open className="group overflow-hidden rounded-lg border" id={`file-${file.path}`}>
      <summary className="flex cursor-pointer list-none items-center gap-3 bg-muted/40 px-3 py-2 text-sm [&::-webkit-details-marker]:hidden">
        <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-not-open:-rotate-90" />
        <Counts additions={file.additions} deletions={file.deletions} />
        <span className="min-w-0 flex-1 truncate font-mono text-[0.8rem]">{file.path}</span>
        <span className="hidden text-xs text-muted-foreground sm:inline">{STATUS_LABEL[file.status]}</span>
        {file.status === "deleted" ? null : (
          <Link href={href.blob(repo, commit, file.path)} className="shrink-0 text-xs text-muted-foreground hover:text-foreground hover:underline">
            View file
          </Link>
        )}
      </summary>
      {file.omitted ? (
        <p className="border-t px-4 py-3 text-sm text-muted-foreground">{file.omitted === "binary" ? "Binary file changed." : "Diff too large to show."}</p>
      ) : file.hunks.length === 0 ? (
        <p className="border-t px-4 py-3 text-sm text-muted-foreground">{file.status === "added" || file.status === "deleted" ? "Empty file." : "Mode changed."}</p>
      ) : (
        <div className="overflow-x-auto border-t">
          <table className="w-full border-collapse font-mono text-[0.8rem] leading-5">
            {file.hunks.map((hunk) => (
              <tbody key={hunk.header}>
                <tr>
                  <td colSpan={3} className="bg-muted/60 px-3 py-1 text-xs text-muted-foreground">
                    {hunk.header}
                  </td>
                </tr>
                {hunk.lines.map((line, index) => (
                  <tr key={index} className={LINE_STYLE[line.kind]}>
                    <td className="w-px px-2 text-right text-muted-foreground select-none">{line.oldLine ?? ""}</td>
                    <td className="w-px border-r px-2 text-right text-muted-foreground select-none">{line.newLine ?? ""}</td>
                    <td className="px-3 whitespace-pre">
                      <span className={cn("mr-2 select-none", line.kind === "add" ? "text-added" : line.kind === "del" ? "text-removed" : "text-transparent")}>
                        {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
                      </span>
                      {line.text}
                    </td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}
    </details>
  );
}

export function CommitPage({ repo, oid }: { repo: RepoName; oid: string }) {
  const view = useApi<CommitView>(apiUrl(`repos/${repo}/commits/${oid}`));
  if (view.status === "loading")
    return (
      <div className="rounded-lg border">
        <LoadingRows />
      </div>
    );
  if (view.status === "error") return <Problem title={view.code === 404 ? "Commit not found" : "Couldn't load the commit"} detail={view.message} />;
  const { commit, files, truncated } = view.data;
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const sameCommitter = commit.author.name === commit.committer.name && commit.author.email === commit.committer.email;
  const rows: [string, React.ReactNode][] = [
    ["Author", commit.author.name],
    ...(sameCommitter ? [] : ([["Committer", commit.committer.name]] as [string, React.ReactNode][])),
    [
      "Date",
      <>
        <Time seconds={commit.author.time} /> <span className="text-muted-foreground">({fullDate(commit.author.time)})</span>
      </>,
    ],
    ["Commit", <span className="font-mono text-xs break-all">{commit.oid}</span>],
    [
      commit.parents.length > 1 ? "Parents" : "Parent",
      commit.parents.length === 0 ? (
        <span className="text-muted-foreground">none</span>
      ) : (
        <span className="flex flex-wrap gap-2">
          {commit.parents.map((parent) => (
            <Link key={parent} href={href.commit(repo, parent)} className="font-mono text-xs hover:underline">
              {shortOid(parent)}
            </Link>
          ))}
        </span>
      ),
    ],
  ];
  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-lg border px-4 py-4 sm:px-5" aria-label="Commit">
        <h1 className="text-lg font-semibold break-words">{commit.subject || "(no message)"}</h1>
        {commit.body ? <pre className="mt-3 font-mono text-[0.8rem] leading-6 whitespace-pre-wrap">{commit.body}</pre> : null}
        <dl className="mt-4 grid grid-cols-[6rem_minmax(0,1fr)] gap-x-4 gap-y-2 border-t pt-4 text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="min-w-0">{value}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-4 flex gap-2 border-t pt-3">
          <Link href={href.tree(repo, commit.oid)} className="text-sm hover:underline">
            Browse files at this commit
          </Link>
        </div>
      </section>
      <div className="flex items-center gap-3 text-sm">
        <Counts additions={additions} deletions={deletions} />
        <span className="text-muted-foreground">{plural(files.length, "changed file")}</span>
      </div>
      {files.map((file) => (
        <FileCard key={file.path} repo={repo} commit={commit.oid} file={file} />
      ))}
      {truncated ? <p className="text-sm text-muted-foreground">This commit changed more files than are shown. Clone the repository to see the rest.</p> : null}
    </div>
  );
}
