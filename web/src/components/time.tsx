import { fullDate, timeAgo } from "@/lib/format";

export function Time({ seconds, className }: { seconds: number; className?: string }) {
  return (
    <time className={className} dateTime={new Date(seconds * 1000).toISOString()} title={fullDate(seconds)}>
      {timeAgo(seconds)}
    </time>
  );
}
