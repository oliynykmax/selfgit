import { Popover, PopoverContent, PopoverDescription, PopoverTitle, PopoverTrigger } from "@ui-sdk/react/popover";
import { toast } from "@ui-sdk/react/toast";
import { Copy, Download } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";

export function cloneUrl(repo: string): string {
  return `${location.origin}/${repo}.git`;
}

export function ClonePopover({ repo }: { repo: string }) {
  const url = cloneUrl(repo);
  return (
    <Popover>
      <PopoverTrigger className={buttonVariants({ variant: "default", size: "default" })}>
        <Download />
        Clone
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(26rem,calc(100vw-2rem))] rounded-lg border bg-popover p-3 shadow-md">
        <PopoverTitle className="text-sm font-medium">Clone over HTTPS</PopoverTitle>
        <PopoverDescription className="mt-0.5 text-xs text-muted-foreground">Anyone can clone and fetch. Pushing needs the owner's GitHub token.</PopoverDescription>
        <div className="mt-3 flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-md border bg-muted/50 px-2 py-1.5 font-mono text-xs">{url}</code>
          <Button
            variant="outline"
            size="icon"
            aria-label="Copy clone URL"
            onClick={async () => {
              await navigator.clipboard.writeText(url);
              toast.success("Clone URL copied");
            }}
          >
            <Copy />
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
