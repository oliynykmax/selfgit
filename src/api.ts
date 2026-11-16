import { isRepoName, type RepoName, REPO_NAMES, type Session } from "./api-types";
import { imageType } from "./browse";
import { currentUser, type OAuthConfig, sameOrigin } from "./oauth";
import type { Result } from "./repo";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function error(status: number, message: string): Response {
  return json({ error: message }, status);
}

function fromResult<T>(result: Result<T>): Response {
  return result.ok ? json(result.value) : error(result.status, result.error);
}

/** Raw file bytes. The sandbox CSP and nosniff keep an HTML or SVG file in a repo from running as part of this site. */
function rawResponse(path: string, content: Uint8Array, binary: boolean): Response {
  const name = path.slice(path.lastIndexOf("/") + 1).replace(/[^\w.-]/g, "_") || "file";
  const image = imageType(path);
  const type = image ?? (binary ? "application/octet-stream" : "text/plain; charset=utf-8");
  return new Response(content, {
    headers: {
      "Content-Type": type,
      "Content-Disposition": `${image || !binary ? "inline" : "attachment"}; filename="${name}"`,
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
}

interface ApiContext {
  request: Request;
  url: URL;
  env: Env;
  auth: OAuthConfig;
}

type RepoStub = DurableObjectStub<import("./repo").Repository>;

function stub(env: Env, repo: RepoName): RepoStub {
  return env.REPOS.getByName(repo);
}

function param(url: URL, name: string, fallback = ""): string {
  return url.searchParams.get(name) ?? fallback;
}

type Handler = (context: ApiContext, repo: RepoStub, name: RepoName, rest: string[]) => Promise<Response>;

const REPO_ROUTES: Record<string, Partial<Record<string, Handler>>> = {
  "": { GET: async (_c, repo, name) => fromResult(await repo.refs(name)) },
  tree: { GET: async ({ url }, repo) => fromResult(await repo.tree(param(url, "ref", "HEAD"), param(url, "path"))) },
  blob: { GET: async ({ url }, repo) => fromResult(await repo.blob(param(url, "ref", "HEAD"), param(url, "path"))) },
  raw: {
    GET: async ({ url }, repo) => {
      const path = param(url, "path");
      const result = await repo.raw(param(url, "ref", "HEAD"), path);
      return result.ok ? rawResponse(path, result.value.content, result.value.binary) : error(result.status, result.error);
    },
  },
  commits: {
    GET: async ({ url }, repo, _name, rest) => {
      if (rest.length === 1) return fromResult(await repo.commit(rest[0]!));
      const page = Number(param(url, "page", "0"));
      if (!Number.isSafeInteger(page) || page < 0) return error(400, "page must be a whole number");
      return fromResult(await repo.log(param(url, "ref", "HEAD"), param(url, "path"), page));
    },
  },
  refs: {
    DELETE: async ({ request, url, auth }, repo) => {
      if (!sameOrigin(request)) return error(403, "Cross-site request refused");
      if (!(await currentUser(request, auth))) return error(401, "Sign in as the owner to delete branches and tags");
      return fromResult(await repo.deleteRef(param(url, "name")));
    },
  },
};

export async function handleApi(context: ApiContext): Promise<Response> {
  const { request, url, env, auth } = context;
  const parts = url.pathname.split("/").slice(2).map(decodeURIComponent);
  const method = request.method === "HEAD" ? "GET" : request.method;

  if (parts[0] === "session" && parts.length === 1 && method === "GET") {
    const user = await currentUser(request, auth);
    const session: Session = user ? { authenticated: true, login: user.login, avatarUrl: user.avatarUrl } : { authenticated: false };
    return json(session);
  }
  if (parts[0] === "repos" && parts.length === 1 && method === "GET") {
    const summaries = await Promise.all(REPO_NAMES.map(async (name) => stub(env, name).summary(name)));
    const failed = summaries.find((result) => !result.ok);
    if (failed && !failed.ok) return error(failed.status, failed.error);
    return json(summaries.flatMap((result) => (result.ok ? [result.value] : [])));
  }
  if (parts[0] === "repos" && parts.length >= 2) {
    const name = parts[1]!;
    if (!isRepoName(name)) return error(404, `No repository named ${name}`);
    const [section = "", ...rest] = parts.slice(2);
    const route = REPO_ROUTES[section];
    if (!route || rest.length > (section === "commits" ? 1 : 0)) return error(404, "Not found");
    const handler = route[method];
    if (!handler) return new Response(null, { status: 405, headers: { Allow: Object.keys(route).join(", ") } });
    return handler(context, stub(env, name), name, rest);
  }
  return error(404, "Not found");
}
