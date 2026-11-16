const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const absolute = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

export function timeAgo(unixSeconds: number, now = Date.now()): string {
  const delta = unixSeconds - Math.round(now / 1000);
  for (const [unit, seconds] of UNITS) {
    if (Math.abs(delta) >= seconds) return relative.format(Math.trunc(delta / seconds), unit);
  }
  return "just now";
}

export function fullDate(unixSeconds: number): string {
  return absolute.format(new Date(unixSeconds * 1000));
}

export function shortOid(oid: string): string {
  return oid.slice(0, 7);
}

export function bytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
