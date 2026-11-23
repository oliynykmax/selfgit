import { PIPELINE_REPO } from "./ci";
import { isRepoName, type RepoName, type Session } from "./api-types";
import { imageType } from "./browse";
import { currentUser, type OAuthConfig, sameOrigin } from "./oauth";
import type { Result } from "./repo";
import { GitHubIdentity } from "./auth";
import { treeSnapshotKey } from "./tree-snapshot";

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

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
function rawResponse(
  path: string,
  content: Uint8Array,
  binary: boolean,
): Response {
  const name =
    path.slice(path.lastIndexOf("/") + 1).replace(/[^\w.-]/g, "_") || "file";
  const image = imageType(path);
  const type =
    image ??
    (binary ? "application/octet-stream" : "text/plain; charset=utf-8");
  return new Response(content, {
    headers: {
      "Content-Type": type,
      "Content-Disposition": `${image || !binary ? "inline" : "attachment"}; filename="${name}"`,
      "Content-Security-Policy":
        "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
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
  identity: GitHubIdentity;
}

export async function authorizeOwner(
  request: Request,
  auth: OAuthConfig,
  identity: GitHubIdentity,
): Promise<Response | null> {
  const authorization = request.headers.get("Authorization");
  if (authorization !== null) {
    const match = /^Bearer ([^\s]+)$/i.exec(authorization);
    if (!match) return error(401, "A GitHub bearer token is required");
    if (!auth.ownerId || !/^\d+$/.test(auth.ownerId))
      return error(503, "Owner is not configured");
    const result = await identity.resolve(match[1]!);
    if (result === "invalid") return error(401, "GitHub rejected the token");
    if (result === "unavailable")
      return error(503, "Could not verify the token with GitHub");
    return result.userId === Number(auth.ownerId)
      ? null
      : error(403, "This GitHub account is not the owner");
  }
  if (!sameOrigin(request)) return error(403, "Cross-site request refused");
  return (await currentUser(request, auth))
    ? null
    : error(401, "Sign in as the owner");
}

type RepoStub = DurableObjectStub<import("./repo").Repository>;

function stub(env: Env, repo: RepoName): RepoStub {
  return env.REPOS.getByName(repo);
}

function param(url: URL, name: string, fallback = ""): string {
  return url.searchParams.get(name) ?? fallback;
}

type Handler = (
  context: ApiContext,
  repo: RepoStub,
  name: RepoName,
  rest: string[],
) => Promise<Response>;

const REPO_ROUTES: Record<string, Partial<Record<string, Handler>>> = {
  "": { GET: async (_c, repo, name) => fromResult(await repo.refs(name)) },
  tree: {
    GET: async ({ url, env }, repo) => {
      const path = param(url, "path");
      const descriptor = await repo.treeDescriptor(param(url, "ref", "HEAD"));
      if (!descriptor.ok) return fromResult(descriptor);
      const { repoId, commit } = descriptor.value;
      const snapshot = await env.OBJECTS.get(
        treeSnapshotKey(repoId, commit, path),
      );
      if (snapshot)
        return new Response(snapshot.body, {
          headers: { ...JSON_HEADERS, "X-Tree-Snapshot": "worker-hit" },
        });
      const response = fromResult(await repo.tree(commit, path));
      response.headers.set("X-Tree-Snapshot", "miss");
      return response;
    },
  },
  blob: {
    GET: async ({ url }, repo) =>
      fromResult(
        await repo.blob(param(url, "ref", "HEAD"), param(url, "path")),
      ),
  },
  raw: {
    GET: async ({ url }, repo) => {
      const path = param(url, "path");
      const result = await repo.raw(param(url, "ref", "HEAD"), path);
      return result.ok
        ? rawResponse(path, result.value.content, result.value.binary)
        : error(result.status, result.error);
    },
  },
  commits: {
    GET: async ({ url }, repo, _name, rest) => {
      if (rest.length === 1) return fromResult(await repo.commit(rest[0]!));
      const page = Number(param(url, "page", "0"));
      if (!Number.isSafeInteger(page) || page < 0)
        return error(400, "page must be a whole number");
      return fromResult(
        await repo.log(param(url, "ref", "HEAD"), param(url, "path"), page),
      );
    },
  },
  refs: {
    DELETE: async ({ request, url, auth, identity }, repo) => {
      const denied = await authorizeOwner(request, auth, identity);
      if (denied) return denied;
      return fromResult(await repo.deleteRef(param(url, "name")));
    },
  },
};

export async function handleApi(context: ApiContext): Promise<Response> {
  const { request, url, env, auth, identity } = context;
  const parts = url.pathname.split("/").slice(2).map(decodeURIComponent);
  const method = request.method === "HEAD" ? "GET" : request.method;

  if (parts[0] === "maintenance" && parts.length === 2 && method === "GET") {
    const denied = await authorizeOwner(request, auth, identity);
    if (denied) return denied;
    const name = parts[1]!;
    if (!/^(selfgit|repo(?:[1-9]|10)|verify-r2-20261117-a)$/.test(name))
      return error(404, "Not found");
    const after = url.searchParams.get("after");
    if (after !== null) {
      if (after !== "" && !/^[0-9a-f]{40}$/.test(after))
        return error(400, "Invalid cursor");
      return json(await env.REPOS.getByName(name).maintenanceHashes(after));
    }
    return json(await env.REPOS.getByName(name).maintenanceAudit());
  }

  if (
    parts[0] === "maintenance" &&
    parts.length === 3 &&
    parts[2] === "repack" &&
    method === "POST"
  ) {
    const denied = await authorizeOwner(request, auth, identity);
    if (denied) return denied;
    const name = parts[1]!;
    if (!(await env.REGISTRY.getByName("registry").list()).includes(name))
      return error(404, "Not found");
    return json(await env.REPOS.getByName(name).maintenanceRepack());
  }

  if (parts[0] === "session" && parts.length === 1 && method === "GET") {
    const user = await currentUser(request, auth);
    const session: Session = user
      ? { authenticated: true, login: user.login, avatarUrl: user.avatarUrl }
      : { authenticated: false };
    return json(session);
  }
  if (parts[0] === "repos" && parts.length === 1 && method === "GET") {
    const names = await env.REGISTRY.getByName("registry").list();
    const summaries = await Promise.all(
      names.map(async (name) => stub(env, name).summary(name)),
    );
    const failed = summaries.find(
      (result) => !result.ok && result.status !== 404,
    );
    if (failed && !failed.ok) return error(failed.status, failed.error);
    return json(
      summaries.flatMap((result) => (result.ok ? [result.value] : [])),
    );
  }
  if (parts[0] === "repos" && parts.length === 1 && method === "POST") {
    const denied = await authorizeOwner(request, auth, identity);
    if (denied) return denied;
    const body: unknown = await request.json().catch(() => null);
    if (
      !body ||
      typeof body !== "object" ||
      !("name" in body) ||
      typeof body.name !== "string" ||
      !isRepoName(body.name)
    )
      return error(
        400,
        "Use lowercase letters, numbers, dots, hyphens or underscores. Names must begin with a letter or number, and cannot end in a dot or .git.",
      );
    if (!(await env.REGISTRY.getByName("registry").create(body.name)))
      return error(409, "Repository already exists");
    return json({ name: body.name }, 201);
  }
  if (parts[0] === "repos" && parts.length >= 2) {
    const name = parts[1]!;
    if (parts.length === 2 && method === "DELETE") {
      if (name === PIPELINE_REPO)
        return error(409, "The pipeline repository cannot be deleted");
      const denied = await authorizeOwner(request, auth, identity);
      if (denied) return denied;
      if (
        !isRepoName(name) ||
        !(await env.REGISTRY.getByName("registry").beginDelete(name))
      )
        return error(404, `No repository named ${name}`);
      await stub(env, name).deleteRepository();
      return json(null);
    }
    if (
      !isRepoName(name) ||
      !(await env.REGISTRY.getByName("registry").exists(name))
    )
      return error(404, `No repository named ${name}`);
    if (
      name === PIPELINE_REPO &&
      parts.length === 3 &&
      parts[2] === "runs" &&
      method === "GET"
    )
      return json(await stub(env, name).ciRuns());
    if (
      name === PIPELINE_REPO &&
      parts.length === 4 &&
      parts[2] === "runs" &&
      /^[1-9][0-9]{0,15}$/.test(parts[3]!) &&
      method === "GET"
    ) {
      const run = await stub(env, name).ciRun(Number(parts[3]));
      return run ? json(run) : error(404, "No such run");
    }
    const [section = "", ...rest] = parts.slice(2);
    const route = REPO_ROUTES[section];
    if (!route || rest.length > (section === "commits" ? 1 : 0))
      return error(404, "Not found");
    const handler = route[method];
    if (!handler)
      return new Response(null, {
        status: 405,
        headers: { Allow: Object.keys(route).join(", ") },
      });
    return handler(context, stub(env, name), name, rest);
  }
  return error(404, "Not found");
}
