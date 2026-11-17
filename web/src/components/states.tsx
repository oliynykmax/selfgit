import { Skeleton } from "@/components/ui/skeleton";

export function LoadingRows({ rows = 6 }: { rows?: number }) {
  return (
    <div className="divide-y" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-4 px-4 py-2.5">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="ml-auto h-4 w-16" />
        </div>
      ))}
    </div>
  );
}

export function Problem({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="px-4 py-12 text-center">
      <p className="font-medium">{title}</p>
      {detail ? (
        <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
      ) : null}
    </div>
  );
}
