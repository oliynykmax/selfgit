import {
  BookOpen,
  File,
  FileSymlink,
  Folder,
  FolderGit2,
  History,
} from "lucide-react";
import { lazy, Suspense, type MouseEvent, useMemo } from "react";
import type {
  BlobView,
  CommitPage,
  EntryKind,
  Readme,
  RepoName,
  RepoRefs,
  TreeView,
} from "../../../src/api-types";
import { ClonePopover, cloneUrl } from "@/components/clone-popover";
import { CommitRow } from "@/components/commit-row";
import { Link } from "@/components/link";
import { RefPicker } from "@/components/ref-picker";
import { LoadingRows, Problem } from "@/components/states";
import { Time } from "@/components/time";
import { buttonVariants } from "@/components/ui/button";
import { useApi } from "@/lib/api";
import { bytes, plural, shortOid } from "@/lib/format";
import { renderMarkdown } from "@/lib/markdown";
import { navigate } from "@/lib/navigation";
import { apiUrl, href, splitRefPath } from "@/lib/route";
import { cn } from "@/lib/utils";

const PANEL = "overflow-hidden rounded-lg border bg-background";

const CodeFile = lazy(async () => ({
  default: (await import("@/components/pierre")).CodeFile,
}));

function rawUrl(repo: RepoName, ref: string, path: string): string {
  return apiUrl(`repos/${repo}/raw`, { ref, path });
}

function refNames(refs: RepoRefs): string[] {
  return [...refs.branches, ...refs.tags].map((ref) => ref.name);
}

function displayRef(ref: string): string {
  return /^[0-9a-f]{40}$/.test(ref) ? shortOid(ref) : ref;
}

function Breadcrumb({
  repo,
  gitRef,
  path,
}: {
  repo: RepoName;
  gitRef: string;
  path: string;
}) {
  const parts = path.split("/").filter(Boolean);
  return (
    <nav
      aria-label="Path"
      className="flex min-w-0 flex-wrap items-center gap-1 text-sm"
    >
      <Link
        href={href.tree(repo, gitRef)}
        className="font-medium hover:underline"
      >
        {repo}
      </Link>
      {parts.map((part, index) => {
        const sub = parts.slice(0, index + 1).join("/");
        const last = index === parts.length - 1;
        return (
          <span key={sub} className="flex items-center gap-1">
            <span className="text-muted-foreground">/</span>
            {last ? (
              <span className="font-medium break-all">{part}</span>
            ) : (
              <Link
                href={href.tree(repo, gitRef, sub)}
                className="break-all hover:underline"
              >
                {part}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}

function Toolbar({
  repo,
  refs,
  gitRef,
  path,
  view,
}: {
  repo: RepoName;
  refs: RepoRefs;
  gitRef: string;
  path: string;
  view: "tree" | "blob";
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <RefPicker
        refs={refs}
        current={gitRef}
        onChange={(next) =>
          navigate(
            view === "tree"
              ? href.tree(repo, next, path)
              : href.blob(repo, next, path),
          )
        }
      />
      {path ? <Breadcrumb repo={repo} gitRef={gitRef} path={path} /> : null}
      <div className="ml-auto flex items-center gap-2">
        <Link
          href={href.commits(repo, gitRef, path)}
          aria-label="History"
          className={buttonVariants({ variant: "ghost", size: "default" })}
        >
          <History />
          <span className="hidden sm:inline">History</span>
        </Link>
        {path ? null : <ClonePopover repo={repo} />}
      </div>
    </div>
  );
}

const ICONS: Record<EntryKind, typeof File> = {
  tree: Folder,
  blob: File,
  symlink: FileSymlink,
  submodule: FolderGit2,
};

function MarkdownBody({
  repo,
  gitRef,
  readme,
}: {
  repo: RepoName;
  gitRef: string;
  readme: Readme;
}) {
  const dir = readme.path.includes("/")
    ? readme.path.slice(0, readme.path.lastIndexOf("/"))
    : "";
  const html = useMemo(
    () =>
      renderMarkdown(readme.text, dir, {
        link: (path) => href.blob(repo, gitRef, path),
        image: (path) => rawUrl(repo, gitRef, path),
      }),
    [readme.text, dir, repo, gitRef],
  );
  function followInternalLink(event: MouseEvent<HTMLDivElement>) {
    const anchor = (event.target as HTMLElement).closest("a");
    const target = anchor?.getAttribute("href");
    if (
      !anchor ||
      !target?.startsWith("/") ||
      target.startsWith("//") ||
      anchor.target === "_blank"
    )
      return;
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    navigate(target);
  }
  // Safe because renderMarkdown passes everything through DOMPurify.
  return (
    <div
      className="markdown"
      onClick={followInternalLink}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function ReadmePanel({
  repo,
  gitRef,
  readme,
}: {
  repo: RepoName;
  gitRef: string;
  readme: Readme;
}) {
  return (
    <section className={cn(PANEL, "mt-4")} aria-label={readme.path}>
      <div className="flex items-center gap-2 border-b px-4 py-2.5 text-sm font-medium">
        <BookOpen className="size-4 text-muted-foreground" />
        {readme.path.slice(readme.path.lastIndexOf("/") + 1)}
      </div>
      <div className="px-4 py-5 sm:px-6">
        {readme.markdown ? (
          <MarkdownBody repo={repo} gitRef={gitRef} readme={readme} />
        ) : (
          <pre className="font-mono text-sm leading-6 whitespace-pre-wrap">
            {readme.text}
          </pre>
        )}
      </div>
    </section>
  );
}

function FileList({
  repo,
  gitRef,
  tree,
}: {
  repo: RepoName;
  gitRef: string;
  tree: TreeView;
}) {
  const parent = tree.path.includes("/")
    ? tree.path.slice(0, tree.path.lastIndexOf("/"))
    : "";
  return (
    <section className={PANEL} aria-label="Files">
      <div className="flex items-center gap-3 border-b bg-muted/40 px-4 py-2.5 text-sm">
        <span className="font-medium">{tree.commit.author.name}</span>
        <Link
          href={href.commit(repo, tree.commit.oid)}
          className="min-w-0 flex-1 truncate text-muted-foreground hover:text-foreground hover:underline"
        >
          {tree.commit.subject}
        </Link>
        <Link
          href={href.commit(repo, tree.commit.oid)}
          className="hidden font-mono text-xs text-muted-foreground hover:underline sm:inline"
        >
          {shortOid(tree.commit.oid)}
        </Link>
        <Time
          seconds={tree.commit.committer.time}
          className="shrink-0 text-xs text-muted-foreground"
        />
      </div>
      <ul className="divide-y text-sm">
        {tree.path ? (
          <li>
            <Link
              href={href.tree(repo, gitRef, parent)}
              aria-label="Parent directory"
              className="flex items-center gap-3 px-4 py-2 text-muted-foreground hover:bg-muted/50"
            >
              <Folder className="size-4" />
              ..
            </Link>
          </li>
        ) : null}
        {tree.entries.map((entry) => {
          const Icon = ICONS[entry.kind];
          const to =
            entry.kind === "tree"
              ? href.tree(repo, gitRef, entry.path)
              : entry.kind === "submodule"
                ? null
                : href.blob(repo, gitRef, entry.path);
          return (
            <li
              key={entry.name}
              className="flex items-center gap-3 px-4 py-2 hover:bg-muted/40"
            >
              <Icon
                className={cn(
                  "size-4 shrink-0",
                  entry.kind === "tree"
                    ? "fill-muted-foreground/25 text-muted-foreground"
                    : "text-muted-foreground",
                )}
              />
              {to ? (
                <Link
                  href={to}
                  className="min-w-0 truncate hover:underline sm:w-56 sm:shrink-0 md:w-64"
                >
                  {entry.name}
                </Link>
              ) : (
                <span
                  className="min-w-0 truncate sm:w-56 sm:shrink-0 md:w-64"
                  title={`Submodule at ${entry.oid}`}
                >
                  {entry.name}{" "}
                  <span className="font-mono text-xs text-muted-foreground">
                    @ {shortOid(entry.oid)}
                  </span>
                </span>
              )}
              {entry.lastCommit ? (
                <>
                  <Link
                    href={href.commit(repo, entry.lastCommit.oid)}
                    className="hidden min-w-0 flex-1 truncate text-muted-foreground hover:text-foreground hover:underline sm:block"
                  >
                    {entry.lastCommit.subject}
                  </Link>
                  <Time
                    seconds={entry.lastCommit.committer.time}
                    className="ml-auto shrink-0 text-xs text-muted-foreground sm:ml-0"
                  />
                </>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Sidebar({
  repo,
  refs,
  gitRef,
}: {
  repo: RepoName;
  refs: RepoRefs;
  gitRef: string;
}) {
  const log = useApi<CommitPage>(
    apiUrl(`repos/${repo}/commits`, { ref: gitRef }),
  );
  const sections = [
    {
      title: "Branches",
      to: href.branches(repo),
      items: refs.branches,
      link: (name: string) => href.tree(repo, name),
      total: refs.branches.length,
    },
    {
      title: "Tags",
      to: href.tags(repo),
      items: refs.tags,
      link: (name: string) => href.tree(repo, name),
      total: refs.tags.length,
    },
  ].filter((section) => section.total > 0);
  return (
    <aside className="flex flex-col gap-4">
      <section className={PANEL} aria-label="Latest commits">
        <div className="flex items-center justify-between border-b px-4 py-2.5 text-sm">
          <Link
            href={href.commits(repo, gitRef)}
            className="font-medium hover:underline"
          >
            Commits
          </Link>
        </div>
        {log.status === "ok" ? (
          <ul className="divide-y text-sm">
            {log.data.commits.slice(0, 3).map((commit) => (
              <CommitRow key={commit.oid} repo={repo} commit={commit} />
            ))}
          </ul>
        ) : (
          <LoadingRows rows={3} />
        )}
      </section>
      {sections.map((section) => (
        <section
          key={section.title}
          className={PANEL}
          aria-label={section.title}
        >
          <div className="flex items-center gap-2 border-b px-4 py-2.5 text-sm">
            <Link href={section.to} className="font-medium hover:underline">
              {section.title}
            </Link>
            <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums">
              {section.total}
            </span>
          </div>
          <ul className="divide-y text-sm">
            {section.items.slice(0, 3).map((ref) => (
              <li key={ref.name} className="flex items-center gap-2 px-4 py-2">
                <Link
                  href={section.link(ref.name)}
                  className="min-w-0 truncate hover:underline"
                >
                  {ref.name}
                </Link>
                {section.title === "Branches" &&
                ref.name === refs.defaultBranch ? (
                  <span className="rounded-md border px-1.5 text-xs text-muted-foreground">
                    default
                  </span>
                ) : null}
                <Time
                  seconds={ref.commit.committer.time}
                  className="ml-auto shrink-0 text-xs text-muted-foreground"
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </aside>
  );
}

function EmptyRepo({ repo }: { repo: RepoName }) {
  const url = cloneUrl(repo);
  return (
    <section className={cn(PANEL, "px-5 py-6")}>
      <h2 className="font-semibold">This repository is empty</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Push an existing repository to it:
      </p>
      <pre className="mt-3 overflow-x-auto rounded-md border bg-muted/50 p-3 font-mono text-xs leading-6">
        {`git remote add origin ${url}\ngit push -u origin main`}
      </pre>
    </section>
  );
}

function useTarget(
  refs: RepoRefs,
  rest: string[],
): { ref: string; path: string } | null | "empty" {
  if (rest.length === 0)
    return refs.defaultBranch ? { ref: refs.defaultBranch, path: "" } : "empty";
  return splitRefPath(rest, refNames(refs));
}

export function TreePage({
  repo,
  refs,
  rest,
}: {
  repo: RepoName;
  refs: RepoRefs;
  rest: string[];
}) {
  const target = useTarget(refs, rest);
  const resolved = target && target !== "empty" ? target : null;
  const tree = useApi<TreeView>(
    resolved
      ? apiUrl(`repos/${repo}/tree`, { ref: resolved.ref, path: resolved.path })
      : null,
  );
  if (target === "empty") return <EmptyRepo repo={repo} />;
  if (!resolved)
    return <Problem title="Branch or tag not found" detail={rest[0]} />;
  const overview = resolved.path === "";
  const showSidebar = overview && tree.status === "ok";
  return (
    <div
      className={cn(
        showSidebar &&
          "grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]",
      )}
    >
      <div className="min-w-0">
        <Toolbar
          repo={repo}
          refs={refs}
          gitRef={resolved.ref}
          path={resolved.path}
          view="tree"
        />
        {tree.status === "loading" ? (
          <div className={PANEL}>
            <LoadingRows />
          </div>
        ) : null}
        {tree.status === "error" ? (
          <div className={PANEL}>
            <Problem
              title={
                tree.code === 404
                  ? "Directory not found"
                  : "Couldn't load files"
              }
              detail={tree.message}
            />
          </div>
        ) : null}
        {tree.status === "ok" ? (
          <>
            <FileList repo={repo} gitRef={resolved.ref} tree={tree.data} />
            {tree.data.readme ? (
              <ReadmePanel
                repo={repo}
                gitRef={resolved.ref}
                readme={tree.data.readme}
              />
            ) : null}
          </>
        ) : null}
      </div>
      {showSidebar ? (
        <Sidebar repo={repo} refs={refs} gitRef={resolved.ref} />
      ) : null}
    </div>
  );
}

function BlobBody({
  repo,
  gitRef,
  blob,
}: {
  repo: RepoName;
  gitRef: string;
  blob: BlobView;
}) {
  const raw = rawUrl(repo, gitRef, blob.path);
  switch (blob.content.kind) {
    case "text":
      return blob.path.match(/\.(md|markdown)$/i) ? (
        <div className="px-4 py-5 sm:px-6">
          <MarkdownBody
            repo={repo}
            gitRef={gitRef}
            readme={{
              path: blob.path,
              markdown: true,
              text: blob.content.text,
            }}
          />
        </div>
      ) : (
        <Suspense fallback={<LoadingRows />}>
          <CodeFile
            name={blob.path}
            contents={blob.content.text}
            cacheKey={blob.oid}
          />
        </Suspense>
      );
    case "image":
      return (
        <div className="grid place-items-center bg-[repeating-conic-gradient(var(--muted)_0_25%,transparent_0_50%)] bg-[length:16px_16px] p-6">
          <img src={raw} alt={blob.path} className="max-h-[70vh] max-w-full" />
        </div>
      );
    case "binary":
    case "too-large":
      return (
        <Problem
          title={
            blob.content.kind === "binary"
              ? "Binary file not shown"
              : "File too large to show"
          }
          detail={`${bytes(blob.size)}. Use Raw to download it, or clone the repository.`}
        />
      );
  }
}

export function BlobPage({
  repo,
  refs,
  rest,
}: {
  repo: RepoName;
  refs: RepoRefs;
  rest: string[];
}) {
  const target = splitRefPath(rest, refNames(refs));
  const blob = useApi<BlobView>(
    target
      ? apiUrl(`repos/${repo}/blob`, { ref: target.ref, path: target.path })
      : null,
  );
  if (!target || !target.path) return <Problem title="File not found" />;
  const lineCount =
    blob.status === "ok" && blob.data.content.kind === "text"
      ? blob.data.content.text.split("\n").length -
        (blob.data.content.text.endsWith("\n") ? 1 : 0)
      : null;
  return (
    <div>
      <Toolbar
        repo={repo}
        refs={refs}
        gitRef={target.ref}
        path={target.path}
        view="blob"
      />
      <section className={PANEL} aria-label={target.path}>
        <div className="flex flex-wrap items-center gap-3 border-b bg-muted/40 px-4 py-2 text-sm">
          {blob.status === "ok" ? (
            <>
              <span className="text-muted-foreground">
                {lineCount !== null ? `${plural(lineCount, "line")} · ` : ""}
                {bytes(blob.data.size)}
              </span>
              <span className="text-muted-foreground">
                at <span className="font-mono">{displayRef(target.ref)}</span>
              </span>
            </>
          ) : null}
          <a
            href={rawUrl(repo, target.ref, target.path)}
            target="_blank"
            rel="noreferrer"
            className={cn(
              buttonVariants({ variant: "outline", size: "sm" }),
              "ml-auto",
            )}
          >
            Raw
          </a>
        </div>
        {blob.status === "loading" ? <LoadingRows /> : null}
        {blob.status === "error" ? (
          <Problem
            title={
              blob.code === 404 ? "File not found" : "Couldn't load the file"
            }
            detail={blob.message}
          />
        ) : null}
        {blob.status === "ok" ? (
          <BlobBody repo={repo} gitRef={target.ref} blob={blob.data} />
        ) : null}
      </section>
    </div>
  );
}
