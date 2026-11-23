import { useEffect } from "react";
import type {
  CiRun,
  CiRunDetail,
  CiState,
  RepoName,
} from "../../../src/api-types";
import { Link } from "@/components/link";
import { LoadingRows, Problem } from "@/components/states";
import { Time } from "@/components/time";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { invalidate, useApi } from "@/lib/api";
import { shortOid } from "@/lib/format";
import { apiUrl, href } from "@/lib/route";
import { cn } from "@/lib/utils";

const LABELS: Record<CiState, string> = {
  queued: "Queued",
  leased: "Running",
  succeeded: "Passed",
  failed: "Failed",
  superseded: "Superseded",
};

const TONES: Record<CiState, string> = {
  queued: "border-border text-muted-foreground",
  leased: "border-amber-500/50 text-amber-600 dark:text-amber-400",
  succeeded: "border-emerald-500/50 text-emerald-600 dark:text-emerald-400",
  failed: "border-red-500/50 text-red-600 dark:text-red-400",
  superseded: "border-border text-muted-foreground",
};

const REFRESH_MS = 5000;

function active(run: CiRun): boolean {
  return run.state === "queued" || run.state === "leased";
}

function duration(run: CiRun): string {
  if (run.finished_at === null) return run.state === "leased" ? "…" : "";
  const seconds = Math.max(
    0,
    Math.round((run.finished_at - run.created_at) / 1000),
  );
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function StateBadge({ state }: { state: CiState }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs font-medium",
        TONES[state],
      )}
    >
      {LABELS[state]}
    </span>
  );
}

/** Reloads the screen's data every few seconds while a job is still waiting or running. */
function useRefreshWhile(on: boolean, url: string) {
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => invalidate(url), REFRESH_MS);
    return () => clearInterval(timer);
  }, [on, url]);
}

export function ActionsPage({ repo }: { repo: RepoName }) {
  const url = apiUrl(`repos/${repo}/runs`);
  const runs = useApi<CiRun[]>(url);
  const data = runs.status === "ok" ? runs.data : null;
  useRefreshWhile(data?.some(active) ?? false, url);
  if (runs.status === "error")
    return <Problem title="Couldn't load runs" detail={runs.message} />;
  if (!data)
    return (
      <div className="overflow-hidden rounded-lg border">
        <LoadingRows />
      </div>
    );
  if (data.length === 0)
    return (
      <Problem title="No runs yet" detail="Pushing to main queues a run." />
    );
  return (
    <div className="overflow-hidden rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40 hover:bg-muted/40">
            <TableHead className="pl-4">Run</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="hidden sm:table-cell">Commit</TableHead>
            <TableHead className="hidden sm:table-cell">Duration</TableHead>
            <TableHead className="pr-4 text-right">Started</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((run) => (
            <TableRow key={run.id}>
              <TableCell className="pl-4">
                <Link
                  href={href.run(repo, run.id)}
                  className="font-medium hover:underline"
                >
                  {run.kind === "ci" ? "CI" : "Backup"} #{run.id}
                </Link>
              </TableCell>
              <TableCell>
                <StateBadge state={run.state} />
              </TableCell>
              <TableCell className="hidden sm:table-cell">
                <Link
                  href={href.commit(repo, run.commit_oid)}
                  className="font-mono text-xs text-muted-foreground hover:underline"
                >
                  {shortOid(run.commit_oid)}
                </Link>
              </TableCell>
              <TableCell className="hidden text-muted-foreground tabular-nums sm:table-cell">
                {duration(run)}
              </TableCell>
              <TableCell className="pr-4 text-right text-muted-foreground">
                <Time seconds={run.created_at / 1000} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function RunPage({ repo, id }: { repo: RepoName; id: number }) {
  const url = apiUrl(`repos/${repo}/runs/${id}`);
  const run = useApi<CiRunDetail>(url);
  const data = run.status === "ok" ? run.data : null;
  useRefreshWhile(data ? active(data) : false, url);
  if (run.status === "error")
    return (
      <Problem
        title={run.code === 404 ? "Run not found" : "Couldn't load the run"}
        detail={run.message}
      />
    );
  if (!data)
    return (
      <div className="overflow-hidden rounded-lg border">
        <LoadingRows rows={3} />
      </div>
    );
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <Link
          href={href.actions(repo)}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          All runs
        </Link>
        <h2 className="font-semibold">
          {data.kind === "ci" ? "CI" : "Backup"} #{data.id}
        </h2>
        <StateBadge state={data.state} />
        <Link
          href={href.commit(repo, data.commit_oid)}
          className="font-mono text-xs text-muted-foreground hover:underline"
        >
          {shortOid(data.commit_oid)}
        </Link>
        <span className="text-sm text-muted-foreground">
          <Time seconds={data.created_at / 1000} />
          {duration(data) ? ` · ${duration(data)}` : ""}
        </span>
      </div>
      <pre
        aria-label="Run log"
        className="max-h-[70vh] overflow-auto rounded-lg border bg-muted/30 p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap"
      >
        {data.log || (active(data) ? "Waiting for output…" : "No output.")}
      </pre>
    </div>
  );
}
