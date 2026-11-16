import {
  Select,
  SelectContent,
  SelectEmpty,
  SelectGroup,
  SelectGroupLabel,
  SelectInput,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectList,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import { Check, ChevronsUpDown, GitBranch } from "lucide-react";
import type { RepoRefs } from "../../../src/api-types";
import { buttonVariants } from "@/components/ui/button";
import { shortOid } from "@/lib/format";
import { cn } from "@/lib/utils";

const ITEM = "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-highlighted:bg-muted data-selected:font-medium";

export function RefPicker({ refs, current, onChange }: { refs: RepoRefs; current: string; onChange: (ref: string) => void }) {
  const known = refs.branches.some((ref) => ref.name === current) || refs.tags.some((ref) => ref.name === current);
  const groups = [
    { label: "Branches", items: refs.branches },
    { label: "Tags", items: refs.tags },
  ].filter((group) => group.items.length > 0);
  return (
    <Select
      value={current}
      onValueChange={(value) => {
        if (typeof value === "string" && value !== current) onChange(value);
      }}
      itemToLabel={(value) => (known ? String(value) : shortOid(String(value)))}
    >
      <SelectTrigger aria-label="Switch branch or tag" className={cn(buttonVariants({ variant: "outline", size: "default" }), "max-w-56 justify-start font-normal before:hidden after:hidden")}>
        <GitBranch className="text-muted-foreground" />
        <span className="truncate">
          <SelectValue />
        </span>
        <ChevronsUpDown className="ml-auto text-muted-foreground" />
      </SelectTrigger>
      <SelectContent className="w-72 max-w-[calc(100vw-2rem)] rounded-lg border bg-popover p-1 shadow-md">
        <SelectInput aria-label="Find a branch or tag" placeholder="Find a branch or tag…" className="mb-1 h-8 w-full rounded-md border px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40" />
        <SelectEmpty className="px-2 text-sm text-muted-foreground data-empty:py-3">Nothing matches.</SelectEmpty>
        <SelectList className="max-h-72 overflow-y-auto">
          {groups.map((group) => (
            <SelectGroup key={group.label}>
              <SelectGroupLabel className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">{group.label}</SelectGroupLabel>
              {group.items.map((ref) => (
                <SelectItem key={`${group.label}:${ref.name}`} value={ref.name} label={ref.name} className={ITEM}>
                  <SelectItemText className="min-w-0 flex-1 truncate" />
                  {group.label === "Branches" && ref.name === refs.defaultBranch ? <span className="text-xs text-muted-foreground">default</span> : null}
                  <SelectItemIndicator className="before:hidden">
                    <Check className="size-4" />
                  </SelectItemIndicator>
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectList>
      </SelectContent>
    </Select>
  );
}
