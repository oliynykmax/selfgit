import { useEffect, useState } from "react";

export type Loadable<T> =
  | { status: "loading" }
  | { status: "error"; code: number; message: string }
  | { status: "ok"; data: T };

const cache = new Map<string, unknown>();
const listeners = new Set<() => void>();

export class ApiError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

async function readError(response: Response): Promise<ApiError> {
  const body = (await response.json().catch(() => null)) as {
    error?: unknown;
  } | null;
  return new ApiError(
    response.status,
    typeof body?.error === "string"
      ? body.error
      : `Request failed (${response.status})`,
  );
}

export async function getJson<T>(
  url: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(url, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw await readError(response);
  return (await response.json()) as T;
}

export async function send(
  url: string,
  method: "POST" | "DELETE",
): Promise<void> {
  const response = await fetch(url, { method });
  if (!response.ok) throw await readError(response);
}

export async function patchJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await readError(response);
  return (await response.json()) as T;
}

/** Drops cached responses whose URL starts with `prefix`, so screens showing them load again. */
export function invalidate(prefix: string): void {
  for (const key of [...cache.keys()])
    if (key.startsWith(prefix)) cache.delete(key);
  for (const listener of listeners) listener();
}

export function useApi<T>(url: string | null): Loadable<T> {
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<{
    url: string | null;
    value: Loadable<T>;
  }>({ url: null, value: { status: "loading" } });

  useEffect(() => {
    const listener = () => setVersion((value) => value + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (url === null) return;
    if (cache.has(url)) {
      setState({ url, value: { status: "ok", data: cache.get(url) as T } });
      return;
    }
    const controller = new AbortController();
    setState((current) =>
      current.url === url ? current : { url, value: { status: "loading" } },
    );
    getJson<T>(url, controller.signal).then(
      (data) => {
        cache.set(url, data);
        setState({ url, value: { status: "ok", data } });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        const failure =
          error instanceof ApiError ? error : new ApiError(0, "Network error");
        setState({
          url,
          value: {
            status: "error",
            code: failure.code,
            message: failure.message,
          },
        });
      },
    );
    return () => controller.abort();
  }, [url, version]);

  if (url === null || state.url !== url) return { status: "loading" };
  return state.value;
}
