import { AsyncLocalStorage } from "node:async_hooks";
import { isRepoName } from "./api-types";

/** Lets the Astro pages read repository data by calling this Worker's own handler, with no network hop. */
export type Backend = (request: Request) => Promise<Response>;

const KEY = "__selfgitBackend";
const holder = globalThis as unknown as Record<
  string,
  AsyncLocalStorage<Backend> | undefined
>;
export const backendStore: AsyncLocalStorage<Backend> = (holder[KEY] ??=
  new AsyncLocalStorage<Backend>());

/** Single-segment paths are repository landing pages, which Astro renders. */
export function isAstroRoute(pathname: string): boolean {
  if (pathname.startsWith("/_astro/")) return true;
  if (/^\/api\/commits\/[^/]+$/.test(pathname)) return true;
  return isRepoName(pathname.slice(1));
}
