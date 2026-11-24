import { toast } from "@ui-sdk/react/toast";
import { useState } from "react";
import {
  DESCRIPTION_LIMIT,
  PIPELINE_REPO,
  type RepoName,
  type RepoRefs,
  type RepoSettings,
  type SettingsPatch,
} from "../../../src/api-types";
import { DeleteRepo } from "@/components/delete-repo";
import { useSession } from "@/components/header";
import { LoadingRows, Problem } from "@/components/states";
import { buttonVariants } from "@/components/ui/button";
import { invalidate, patchJson } from "@/lib/api";
import { apiUrl } from "@/lib/route";
import { cn } from "@/lib/utils";

const FIELD = "w-full rounded-md border bg-background px-3 py-2 text-sm";

function Section({
  title,
  danger,
  children,
}: {
  title: string;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2
        className={cn(
          "text-lg font-semibold tracking-tight",
          danger && "text-destructive",
        )}
      >
        {title}
      </h2>
      <div
        className={cn(
          "mt-3 divide-y overflow-hidden rounded-lg border",
          danger && "border-destructive/40",
        )}
      >
        {children}
      </div>
    </section>
  );
}

function Setting({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between sm:gap-8">
      <div className="sm:max-w-xs">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-0.5 text-sm text-muted-foreground">{hint}</p>
      </div>
      {children}
    </div>
  );
}

async function save(repo: RepoName, patch: SettingsPatch, done: string) {
  try {
    await patchJson<RepoSettings>(apiUrl(`repos/${repo}/settings`), patch);
  } catch (error) {
    toast.error("Couldn't save the setting", {
      description: error instanceof Error ? error.message : undefined,
    });
    return;
  }
  invalidate("/api/repos");
  toast.success(done);
}

function DefaultBranch({ repo, refs }: { repo: RepoName; refs: RepoRefs }) {
  const current = refs.defaultBranch ?? "";
  const [selected, setSelected] = useState(current);
  const [busy, setBusy] = useState(false);
  const empty = refs.branches.length === 0;
  return (
    <form
      className="flex w-full gap-2 sm:max-w-sm"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        await save(
          repo,
          { defaultBranch: selected },
          `Default branch is now ${selected}`,
        );
        setBusy(false);
      }}
    >
      <select
        aria-label="Default branch"
        value={selected}
        disabled={empty}
        onChange={(event) => setSelected(event.target.value)}
        className={FIELD}
      >
        {empty ? <option value="">No branches yet</option> : null}
        {refs.branches.map((branch) => (
          <option key={branch.name} value={branch.name}>
            {branch.name}
          </option>
        ))}
      </select>
      <button
        aria-label="Save default branch"
        disabled={busy || empty || selected === current}
        className={buttonVariants()}
      >
        Save
      </button>
    </form>
  );
}

function Description({ repo, refs }: { repo: RepoName; refs: RepoRefs }) {
  const [text, setText] = useState(refs.description);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="flex w-full gap-2 sm:max-w-sm"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        await save(repo, { description: text.trim() }, "Description saved");
        setBusy(false);
      }}
    >
      <input
        aria-label="Description"
        value={text}
        maxLength={DESCRIPTION_LIMIT}
        placeholder="What is this repository for?"
        onChange={(event) => setText(event.target.value)}
        className={FIELD}
      />
      <button
        aria-label="Save description"
        disabled={busy || text.trim() === refs.description}
        className={buttonVariants()}
      >
        Save
      </button>
    </form>
  );
}

export function SettingsPage({
  repo,
  refs,
}: {
  repo: RepoName;
  refs: RepoRefs;
}) {
  const session = useSession();
  if (!session) return <LoadingRows rows={3} />;
  if (!session.authenticated)
    return (
      <Problem
        title="Owner sign-in required"
        detail="Sign in as the owner to change this repository's settings."
      />
    );
  return (
    <div className="max-w-3xl space-y-8">
      <Section title="General">
        <Setting
          title="Default branch"
          hint="Clones check this branch out, and the Code tab opens on it."
        >
          <DefaultBranch
            key={refs.defaultBranch ?? ""}
            repo={repo}
            refs={refs}
          />
        </Setting>
        <Setting
          title="Description"
          hint={`Shown under the repository name. Up to ${DESCRIPTION_LIMIT} characters.`}
        >
          <Description key={refs.description} repo={repo} refs={refs} />
        </Setting>
      </Section>
      <Section title="Danger zone" danger>
        <Setting
          title="Delete this repository"
          hint={
            repo === PIPELINE_REPO
              ? "The pipeline repository cannot be deleted. Pushes to its main branch run CI and deploys."
              : "Removes every branch, tag and commit. This cannot be undone."
          }
        >
          {repo === PIPELINE_REPO ? (
            <button
              disabled
              className={buttonVariants({ variant: "destructive" })}
            >
              Delete this repository
            </button>
          ) : (
            <DeleteRepo repo={repo} />
          )}
        </Setting>
      </Section>
    </div>
  );
}
