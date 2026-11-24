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
import { useState } from "react";
import type { RepoName } from "../../../src/api-types";
import { buttonVariants } from "@/components/ui/button";
import { invalidate, send } from "@/lib/api";
import { navigate } from "@/lib/navigation";
import { apiUrl } from "@/lib/route";

export function DeleteRepo({ repo }: { repo: RepoName }) {
  const [typed, setTyped] = useState("");
  async function remove() {
    try {
      await send(apiUrl(`repos/${repo}`), "DELETE");
    } catch (error) {
      toast.error(`Couldn't delete ${repo}`, {
        description: error instanceof Error ? error.message : undefined,
      });
      throw error;
    }
    navigate("/");
    invalidate("/api/");
    toast.success(`Deleted repository ${repo}`);
  }

  return (
    <AlertDialog onOpenChange={() => setTyped("")}>
      <AlertDialogTrigger
        className={buttonVariants({ variant: "destructive" })}
      >
        Delete this repository
      </AlertDialogTrigger>
      <AlertDialogBackdrop className="fixed inset-0 bg-black/20" />
      <AlertDialogContent className="rounded-xl border bg-background p-5 text-left whitespace-normal shadow-lg">
        <AlertDialogTitle className="text-base font-semibold">
          Delete <span className="font-mono">{repo}</span>?
        </AlertDialogTitle>
        <AlertDialogDescription className="mt-2 text-sm text-muted-foreground">
          Every branch, tag and commit of {repo} is removed for everyone. This
          cannot be undone.
        </AlertDialogDescription>
        <label htmlFor="confirm-repo-name" className="mt-4 block text-sm">
          Type <span className="font-mono font-medium">{repo}</span> to confirm
        </label>
        <input
          id="confirm-repo-name"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          className="mt-1.5 w-full rounded-md border bg-background px-3 py-2 font-mono text-sm"
        />
        <div className="mt-5 flex justify-end gap-2">
          <AlertDialogClose className={buttonVariants({ variant: "outline" })}>
            Cancel
          </AlertDialogClose>
          <AlertDialogClose
            value="confirm"
            action={remove}
            disabled={typed !== repo}
            data-agent-confirm={`Permanently deletes the repository ${repo}`}
            className={buttonVariants({ variant: "destructive" })}
          >
            Delete repository
          </AlertDialogClose>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
