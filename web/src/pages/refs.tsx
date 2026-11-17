import type { RepoName, RepoRefs } from "../../../src/api-types";
import { DeleteRef } from "@/components/delete-ref";
import { useSession } from "@/components/header";
import { Link } from "@/components/link";
import { Problem } from "@/components/states";
import { Time } from "@/components/time";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { shortOid } from "@/lib/format";
import { href } from "@/lib/route";

export function RefsPage({
  repo,
  refs,
  kind,
}: {
  repo: RepoName;
  refs: RepoRefs;
  kind: "branch" | "tag";
}) {
  const owner = useSession()?.authenticated ?? false;
  const items = kind === "branch" ? refs.branches : refs.tags;
  if (items.length === 0)
    return (
      <Problem title={kind === "branch" ? "No branches yet" : "No tags yet"} />
    );
  return (
    <div className="overflow-hidden rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40 hover:bg-muted/40">
            <TableHead className="pl-4">
              {kind === "branch" ? "Branch" : "Tag"}
            </TableHead>
            <TableHead className="hidden md:table-cell">
              Latest commit
            </TableHead>
            <TableHead className="text-right">Updated</TableHead>
            {owner ? (
              <TableHead className="w-12 pr-4" aria-label="Actions" />
            ) : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((ref) => {
            const isDefault =
              kind === "branch" && ref.name === refs.defaultBranch;
            return (
              <TableRow key={ref.name}>
                <TableCell className="max-w-48 pl-4 sm:max-w-none">
                  <div className="flex items-center gap-2">
                    <Link
                      href={href.tree(repo, ref.name)}
                      className="truncate font-medium hover:underline"
                    >
                      {ref.name}
                    </Link>
                    {isDefault ? (
                      <span className="rounded-md border px-1.5 text-xs text-muted-foreground">
                        default
                      </span>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="hidden max-w-0 md:table-cell">
                  <div className="flex items-center gap-2">
                    <Link
                      href={href.commit(repo, ref.commit.oid)}
                      className="shrink-0 font-mono text-xs text-muted-foreground hover:underline"
                    >
                      {shortOid(ref.commit.oid)}
                    </Link>
                    <span className="truncate text-muted-foreground">
                      {ref.commit.subject}
                    </span>
                  </div>
                </TableCell>
                <TableCell className="text-right text-muted-foreground">
                  <Time seconds={ref.commit.committer.time} />
                </TableCell>
                {owner ? (
                  <TableCell className="pr-4 text-right">
                    {isDefault ? null : (
                      <DeleteRef repo={repo} kind={kind} name={ref.name} />
                    )}
                  </TableCell>
                ) : null}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
