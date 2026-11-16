import { isRepoName } from "./api-types";
import { handleApi } from "./api";
import { denyPush, GitHubIdentity } from "./auth";
import { CALLBACK_PATH, finishLogin, LOGIN_PATH, LOGOUT_PATH, logout, type OAuthConfig, startLogin } from "./oauth";

export { Repository } from "./repo";
export { Registry } from "./registry";
export { Sessions } from "./sessions";

const GIT_ROUTE = /^\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const GIT_LOOKING = /^\/[^/]+\.git(\/|$)|^\/[^/]+\/(info\/refs|git-upload-pack|git-receive-pack)$/;
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

function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(`${body}\n`, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...headers } });
}

async function git(request: Request, env: Env, repo: string, endpoint: string, url: URL): Promise<Response> {
  if (!isRepoName(repo) || !(await env.REGISTRY.getByName("registry").exists(repo))) return text(404, "Not found");
  const service = endpoint === "info/refs" ? url.searchParams.get("service") : endpoint;
  if (service !== "git-upload-pack" && service !== "git-receive-pack") {
    return text(403, "Only the smart HTTP protocol is supported");
  }
  const method = endpoint === "info/refs" ? "GET" : "POST";
  if (request.method !== method && !(method === "GET" && request.method === "HEAD")) {
    return text(405, "Method not allowed", { Allow: method });
  }
  if (service === "git-receive-pack") {
    const denied = await denyPush(request, env.GITHUB_OWNER_ID, identity);
    if (denied) return denied;
  }
  return env.REPOS.getByName(repo).fetch(request);
}

async function page(request: Request, env: Env): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  const secured = new Response(response.body, response);
  for (const [name, value] of Object.entries(PAGE_HEADERS)) secured.headers.set(name, value);
  return secured;
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const gitMatch = GIT_ROUTE.exec(url.pathname);
    if (gitMatch) return git(request, env, gitMatch[1]!, gitMatch[2]!, url);
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
    if (url.pathname.startsWith("/api/")) return handleApi({ request, url, env, auth });
    return page(request, env);
  },
} satisfies ExportedHandler<Env>;
