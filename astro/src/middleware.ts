import type { MiddlewareHandler } from "astro";
import { env } from "cloudflare:workers";

type ServiceBinding = {
  fetch(request: Request): Promise<Response>;
};

const selfgit = (env as unknown as { SELF_GIT: ServiceBinding }).SELF_GIT;
const REPO_NAME = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9_-])?$/;

function isAstroRoute(pathname: string): boolean {
  if (pathname.startsWith("/_astro/")) return true;
  if (/^\/api\/commits\/[^/]+$/.test(pathname)) return true;
  const repo = pathname.slice(1);
  return REPO_NAME.test(repo) && !repo.endsWith(".git");
}

export const onRequest: MiddlewareHandler = (context, next) =>
  isAstroRoute(context.url.pathname) ? next() : selfgit.fetch(context.request);
