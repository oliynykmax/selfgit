import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

export function navigate(to: string, { replace = false } = {}): void {
  if (replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  window.scrollTo(0, 0);
  for (const listener of listeners) listener();
}

export function useLocation(): { pathname: string; search: string } {
  const pathname = useSyncExternalStore(subscribe, () => location.pathname);
  const search = useSyncExternalStore(subscribe, () => location.search);
  return { pathname, search };
}
