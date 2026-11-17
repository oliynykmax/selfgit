import {
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@ui-sdk/react/alert-dialog";
import { toast } from "@ui-sdk/react/toast";
import { Trash2 } from "lucide-react";
import type { RepoName } from "../../../src/api-types";
import { buttonVariants } from "@/components/ui/button";
import { invalidate, send } from "@/lib/api";
import { apiUrl } from "@/lib/route";
import { cn } from "@/lib/utils";

export function DeleteRef({
  repo,
  kind,
  name,
}: {
  repo: RepoName;
  kind: "branch" | "tag";
  name: string;
}) {
  const fullName = `refs/${kind === "branch" ? "heads" : "tags"}/${name}`;
  async function remove() {
    try {
      await send(apiUrl(`repos/${repo}/refs`, { name: fullName }), "DELETE");
    } catch (error) {
      toast.error(`Couldn't delete ${name}`, {
        description: error instanceof Error ? error.message : undefined,
      });
      throw error;
    }
    invalidate("/api/repos");
    toast.success(`Deleted ${kind} ${name}`);
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger
        aria-label={`Delete ${kind} ${name}`}
        className={cn(
          buttonVariants({ variant: "ghost", size: "icon-sm" }),
          "text-muted-foreground hover:text-destructive",
        )}
      >
        <Trash2 />
      </AlertDialogTrigger>
      <AlertDialogBackdrop className="fixed inset-0 bg-black/20" />
      <AlertDialogContent className="fixed top-1/2 left-1/2 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border bg-background p-5 shadow-lg">
        <AlertDialogTitle className="text-base font-semibold">
          Delete {kind} <span className="font-mono">{name}</span>?
        </AlertDialogTitle>
        <AlertDialogDescription className="mt-2 text-sm text-muted-foreground">
          The {kind} disappears from {repo} for everyone. Its commits stay
          stored, so pushing the {kind} again restores it.
        </AlertDialogDescription>
        <div className="mt-5 flex justify-end gap-2">
          <AlertDialogClose className={buttonVariants({ variant: "outline" })}>
            Cancel
          </AlertDialogClose>
          <AlertDialogClose
            value="confirm"
            action={remove}
            data-agent-confirm={`Deletes the ${kind} ${name} from ${repo}`}
            className={buttonVariants({ variant: "destructive" })}
          >
            Yes, delete
          </AlertDialogClose>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
