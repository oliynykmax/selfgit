import { PIPELINE_REPO } from "./ci";
import { isRepoName } from "./api-types";
import { handleApi } from "./api";
import { denyPush, GitHubIdentity } from "./auth";
import {
  CALLBACK_PATH,
  finishLogin,
  LOGIN_PATH,
  LOGOUT_PATH,
  logout,
  type OAuthConfig,
  startLogin,
} from "./oauth";

export { Repository } from "./repo";
export { Registry } from "./registry";
export { Sessions } from "./sessions";

const GIT_ROUTE =
  /^\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const GIT_LOOKING =
  /^\/[^/]+\.git(\/|$)|^\/[^/]+\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const githubFetch = (input: string, init: RequestInit) => fetch(input, init);
const identity = new GitHubIdentity(githubFetch);

const PAGE_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' https: data:",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

function text(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(`${body}\n`, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...headers },
  });
}

async function git(
  request: Request,
  env: Env,
  repo: string,
  endpoint: string,
  url: URL,
  identity: GitHubIdentity,
): Promise<Response> {
  if (
    !isRepoName(repo) ||
    !(await env.REGISTRY.getByName("registry").exists(repo))
  )
    return text(404, "Not found");
  const service =
    endpoint === "info/refs" ? url.searchParams.get("service") : endpoint;
  if (service !== "git-upload-pack" && service !== "git-receive-pack") {
    return text(403, "Only the smart HTTP protocol is supported");
  }
  const method = endpoint === "info/refs" ? "GET" : "POST";
  if (
    request.method !== method &&
    !(method === "GET" && request.method === "HEAD")
  ) {
    return text(405, "Method not allowed", { Allow: method });
  }
  if (service === "git-receive-pack") {
    const denied = await denyPush(request, env.GITHUB_OWNER_ID, identity);
    if (denied) return denied;
  }
  return env.REPOS.getByName(repo).fetch(request);
}

async function runner(
  request: Request,
  env: Env,
  path: string,
): Promise<Response> {
  const secret = (env as Env & { CI_RUNNER_TOKEN_HASH?: string })
    .CI_RUNNER_TOKEN_HASH;
  const match = /^Bearer ([^\s]+)$/i.exec(
    request.headers.get("Authorization") ?? "",
  );
  if (!secret || !/^[0-9a-f]{64}$/.test(secret) || !match)
    return text(401, "Unauthorized");
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(match[1]!)),
  );
  const expected = Uint8Array.from(secret.match(/../g)!, (part) =>
    parseInt(part, 16),
  );
  if (!crypto.subtle.timingSafeEqual(digest, expected))
    return text(401, "Unauthorized");
  if (request.method !== "POST") return text(405, "Method not allowed");
  if (Number(request.headers.get("Content-Length") ?? 0) > 8192)
    return text(413, "Body too large");
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader)
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 8192) {
        await reader.cancel();
        return text(413, "Body too large");
      }
      chunks.push(part.value);
    }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return text(400, "Invalid JSON");
  }
  if (!body || typeof body !== "object") return text(400, "Invalid body");
  const repo = env.REPOS.getByName(PIPELINE_REPO);
  if (path === "/api/runner/claim" && "kind" in body && body.kind === "ci")
    return Response.json(await repo.ciClaim(body.kind));
  if (
    !("id" in body) ||
    !Number.isSafeInteger(body.id) ||
    typeof body.id !== "number" ||
    !("leaseToken" in body) ||
    typeof body.leaseToken !== "string"
  )
    return text(400, "Invalid lease");
  if (
    path === "/api/runner/log" &&
    "text" in body &&
    typeof body.text === "string"
  )
    return Response.json({
      ok: await repo.ciLog(body.id, body.leaseToken, body.text),
    });
  if (path === "/api/runner/heartbeat")
    return Response.json({
      ok: await repo.ciHeartbeat(body.id, body.leaseToken),
    });
  if (
    path === "/api/runner/finish" &&
    "success" in body &&
    typeof body.success === "boolean"
  )
    return Response.json({
      ok: await repo.ciFinish(body.id, body.leaseToken, body.success),
    });
  return text(404, "Not found");
}

async function page(request: Request, env: Env): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  const secured = new Response(response.body, response);
  for (const [name, value] of Object.entries(PAGE_HEADERS))
    secured.headers.set(name, value);
  return secured;
}

export function createHandler(identity: GitHubIdentity) {
  return {
    async fetch(request, env, ctx): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/runner/"))
        return runner(request, env, url.pathname);
      const gitMatch = GIT_ROUTE.exec(url.pathname);
      if (gitMatch)
        return git(request, env, gitMatch[1]!, gitMatch[2]!, url, identity);
      if (GIT_LOOKING.test(url.pathname)) return text(404, "Not found");

      const auth: OAuthConfig = {
        clientId: env.GITHUB_OAUTH_CLIENT_ID,
        clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET,
        ownerId: env.GITHUB_OWNER_ID,
        fetcher: githubFetch,
        sessions: env.SESSIONS.getByName("sessions"),
        waitUntil: (promise) => ctx.waitUntil(promise),
      };
      if (url.pathname === LOGIN_PATH) return startLogin(request, auth);
      if (url.pathname === CALLBACK_PATH) return finishLogin(request, auth);
      if (url.pathname === LOGOUT_PATH) return logout(request, auth);
      if (url.pathname.startsWith("/api/"))
        return handleApi({ request, url, env, auth, identity });
      return page(request, env);
    },
  } satisfies ExportedHandler<Env>;
}

export default createHandler(identity);
