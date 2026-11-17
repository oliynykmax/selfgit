import { useState } from "react";
import { useSession } from "@/components/header";
import { buttonVariants } from "@/components/ui/button";
import { invalidate } from "@/lib/api";
import { navigate } from "@/lib/navigation";
import type { RepoSummary } from "../../../src/api-types";
import { Link } from "@/components/link";
import { LoadingRows, Problem } from "@/components/states";
import { Time } from "@/components/time";
import { useApi } from "@/lib/api";
import { plural } from "@/lib/format";
import { href } from "@/lib/route";

export function Home() {
  const session = useSession();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const result = (await response.json()) as {
        error?: string;
        name?: string;
      };
      if (!response.ok)
        throw new Error(result.error ?? "Could not create repository");
      invalidate("/api/repos");
      navigate(`/${result.name}`);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not create repository",
      );
    } finally {
      setBusy(false);
    }
  }
  const repos = useApi<RepoSummary[]>("/api/repos");
  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Repositories</h1>
        {session?.authenticated ? (
          <button
            className={buttonVariants({ size: "sm" })}
            onClick={() => setCreating(!creating)}
          >
            New repository
          </button>
        ) : null}
      </div>
      {creating ? (
        <form
          onSubmit={create}
          className="mt-5 max-w-lg space-y-3 rounded-lg border p-4"
        >
          <label htmlFor="repo-name" className="block text-sm font-medium">
            Repository name
          </label>
          <input
            id="repo-name"
            required
            maxLength={64}
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            autoFocus
          />
          <p className="text-sm text-muted-foreground">
            Lowercase letters, numbers, dots, hyphens and underscores.
          </p>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <button disabled={busy} className={buttonVariants({ size: "sm" })}>
            {busy ? "Creating…" : "Create repository"}
          </button>
        </form>
      ) : null}
      <div className="mt-5 overflow-hidden rounded-lg border">
        {repos.status === "loading" ? <LoadingRows rows={10} /> : null}
        {repos.status === "error" ? (
          <Problem title="Couldn't load repositories" detail={repos.message} />
        ) : null}
        {repos.status === "ok" ? (
          <ul className="divide-y">
            {repos.data.length === 0 ? (
              <li className="px-4 py-6 text-sm text-muted-foreground">
                No repositories yet.
              </li>
            ) : null}
            {repos.data.map((repo) => (
              <li key={repo.name}>
                <Link
                  href={href.repo(repo.name)}
                  className="flex flex-col gap-1 px-4 py-3 hover:bg-muted/50 sm:flex-row sm:items-center sm:gap-4"
                >
                  <span className="w-24 shrink-0 font-medium">{repo.name}</span>
                  {repo.lastCommit ? (
                    <>
                      <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                        {repo.lastCommit.subject}
                      </span>
                      <span className="flex shrink-0 gap-3 text-xs text-muted-foreground">
                        <span>
                          {plural(repo.branchCount, "branch", "branches")}
                        </span>
                        <Time seconds={repo.lastCommit.committer.time} />
                      </span>
                    </>
                  ) : (
                    <span className="flex-1 text-sm text-muted-foreground">
                      Empty
                    </span>
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
