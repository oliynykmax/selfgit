import type { RepoName, RepoRefs } from "../../../src/api-types";
import { Link } from "@/components/link";
import { Problem } from "@/components/states";
import { useApi } from "@/lib/api";
import { apiUrl, href, type RepoTab, type Route, tabOf } from "@/lib/route";
import { cn } from "@/lib/utils";
import { BlobPage, TreePage } from "./code";
import { CommitPage } from "./commit";
import { CommitsPage } from "./commits";
import { RefsPage } from "./refs";

type RepoRoute = Exclude<Route, { kind: "home" } | { kind: "not-found" }>;

function Tabs({
  repo,
  refs,
  active,
}: {
  repo: RepoName;
  refs: RepoRefs | null;
  active: RepoTab;
}) {
  const tabs: { id: RepoTab; label: string; to: string; count?: number }[] = [
    { id: "code", label: "Code", to: href.repo(repo) },
    {
      id: "commits",
      label: "Commits",
      to: refs?.defaultBranch
        ? href.commits(repo, refs.defaultBranch)
        : href.repo(repo),
    },
    {
      id: "branches",
      label: "Branches",
      to: href.branches(repo),
      count: refs?.branches.length,
    },
    {
      id: "tags",
      label: "Tags",
      to: href.tags(repo),
      count: refs?.tags.length,
    },
  ];
  return (
    <nav aria-label="Repository" className="-mb-px flex gap-1 overflow-x-auto">
      {tabs.map((tab) => (
        <Link
          key={tab.id}
          href={tab.to}
          aria-current={tab.id === active ? "page" : undefined}
          className={cn(
            "flex shrink-0 items-center gap-1.5 rounded-t-md border border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground",
            tab.id === active &&
              "border-border border-b-background bg-background font-medium text-foreground",
          )}
        >
          {tab.label}
          {tab.count !== undefined && tab.count > 0 ? (
            <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums">
              {tab.count}
            </span>
          ) : null}
        </Link>
      ))}
    </nav>
  );
}

export function RepoPage({ route }: { route: RepoRoute }) {
  const refs = useApi<RepoRefs>(apiUrl(`repos/${route.repo}`));
  const data = refs.status === "ok" ? refs.data : null;
  return (
    <main className="mx-auto max-w-6xl px-4 pt-6 pb-12">
      <div className="flex items-center gap-2 text-xl">
        <Link href="/" className="text-muted-foreground hover:text-foreground">
          git.oliinyk.dev
        </Link>
        <span className="text-muted-foreground">/</span>
        <Link href={href.repo(route.repo)} className="font-semibold">
          {route.repo}
        </Link>
      </div>
      <div className="mt-5 border-b">
        <Tabs repo={route.repo} refs={data} active={tabOf(route) ?? "code"} />
      </div>
      <div className="mt-4">
        {refs.status === "error" ? (
          <Problem title="Couldn't load the repository" detail={refs.message} />
        ) : null}
        {data ? <RepoView route={route} refs={data} /> : null}
      </div>
    </main>
  );
}

function RepoView({ route, refs }: { route: RepoRoute; refs: RepoRefs }) {
  switch (route.kind) {
    case "tree":
      return <TreePage repo={route.repo} refs={refs} rest={route.rest} />;
    case "blob":
      return <BlobPage repo={route.repo} refs={refs} rest={route.rest} />;
    case "commits":
      return <CommitsPage repo={route.repo} refs={refs} rest={route.rest} />;
    case "commit":
      return <CommitPage repo={route.repo} oid={route.oid} />;
    case "branches":
      return <RefsPage repo={route.repo} refs={refs} kind="branch" />;
    case "tags":
      return <RefsPage repo={route.repo} refs={refs} kind="tag" />;
  }
}
