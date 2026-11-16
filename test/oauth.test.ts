import { describe, expect, test } from "bun:test";
import type { Fetcher } from "../src/auth";
import { currentUser, finishLogin, logout, type OAuthConfig, startLogin } from "../src/oauth";
import type { SessionStore, SessionUser } from "../src/sessions";

const SITE = "https://git.example";
const OWNER = "85843900";
const CODE_OWNER = "code-owner";
const CODE_OTHER = "code-other";

function memorySessions() {
  const rows = new Map<string, { user: SessionUser; expiresAt: number }>();
  const store: SessionStore = {
    async create(idHash, user, expiresAt) {
      rows.set(idHash, { user, expiresAt });
    },
    async get(idHash, now) {
      const row = rows.get(idHash);
      return row && row.expiresAt > now ? row.user : null;
    },
    async delete(idHash) {
      rows.delete(idHash);
    },
  };
  return { store, rows };
}

function fakeGitHub() {
  const calls: { url: string; method: string; body: string }[] = [];
  const fetcher: Fetcher = async (url, init) => {
    const body = typeof init.body === "string" ? init.body : "";
    calls.push({ url, method: init.method ?? "GET", body });
    if (url === "https://github.com/login/oauth/access_token") {
      const params = new URLSearchParams(body);
      if (params.get("client_secret") !== "secret" || !params.get("code_verifier")) return Response.json({ error: "bad_verification_code" });
      const code = params.get("code");
      if (code === CODE_OWNER) return Response.json({ access_token: "gho_owner_token" });
      if (code === CODE_OTHER) return Response.json({ access_token: "gho_other_token" });
      return Response.json({ error: "bad_verification_code" });
    }
    if (url === "https://api.github.com/user") {
      const auth = new Headers(init.headers).get("Authorization");
      if (auth === "Bearer gho_owner_token") return Response.json({ id: Number(OWNER), login: "owner", avatar_url: "https://avatars.example/o" });
      if (auth === "Bearer gho_other_token") return Response.json({ id: 1, login: "intruder", avatar_url: "" });
      return new Response("{}", { status: 401 });
    }
    if (url.startsWith("https://api.github.com/applications/client-id/token")) return new Response(null, { status: 204 });
    return new Response("unexpected", { status: 500 });
  };
  return { fetcher, calls };
}

function setup(overrides: Partial<OAuthConfig> = {}) {
  const github = fakeGitHub();
  const sessions = memorySessions();
  const pending: Promise<unknown>[] = [];
  const config: OAuthConfig = {
    clientId: "client-id",
    clientSecret: "secret",
    ownerId: OWNER,
    fetcher: github.fetcher,
    sessions: sessions.store,
    waitUntil: (promise) => pending.push(promise),
    ...overrides,
  };
  return { config, github, sessions, pending };
}

function cookieValue(response: Response, name: string): string | undefined {
  const header = response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
  return header?.slice(name.length + 1).split(";")[0];
}

async function begin(config: OAuthConfig, next = "/repo1/tree/main") {
  const response = await startLogin(new Request(`${SITE}/auth/github/login?next=${encodeURIComponent(next)}`), config);
  const location = new URL(response.headers.get("Location")!);
  const flow = cookieValue(response, "__Host-selfgit-oauth")!;
  return { response, location, flow };
}

function callback(params: Record<string, string>, flow?: string): Request {
  return new Request(`${SITE}/auth/github/callback?${new URLSearchParams(params)}`, {
    headers: flow ? { Cookie: `__Host-selfgit-oauth=${flow}` } : {},
  });
}

describe("GitHub OAuth sign-in", () => {
  test("login redirects to GitHub with state, PKCE and the exact callback, in a short-lived HttpOnly cookie", async () => {
    const { config } = setup();
    const { response, location } = await begin(config);
    expect(response.status).toBe(302);
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("client-id");
    expect(location.searchParams.get("redirect_uri")).toBe(`${SITE}/auth/github/callback`);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("state")).toMatch(/^[\w-]{43}$/);
    expect(location.searchParams.get("scope")).toBeNull();
    const cookie = response.headers.getSetCookie()[0]!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=600");
    expect(cookie).toContain(location.searchParams.get("state")!);
  });

  test("the owner gets a session; the GitHub token is revoked and never reaches the browser", async () => {
    const { config, github, sessions, pending } = setup();
    const { location, flow } = await begin(config);
    const response = await finishLogin(callback({ code: CODE_OWNER, state: location.searchParams.get("state")! }, flow), config);
    await Promise.all(pending);

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/repo1/tree/main");
    const session = cookieValue(response, "__Host-selfgit-session")!;
    expect(session).toMatch(/^[\w-]{43}$/);
    expect(cookieValue(response, "__Host-selfgit-oauth")).toBe("");
    expect(JSON.stringify([...response.headers])).not.toContain("gho_");
    expect([...sessions.rows.keys()]).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)]);
    expect(sessions.rows.has(session)).toBe(false);

    const exchange = github.calls.find((call) => call.url.endsWith("/access_token"))!;
    expect(new URLSearchParams(exchange.body).get("code_verifier")).toBe(flow.split(".")[1]!);
    const revoke = github.calls.find((call) => call.method === "DELETE")!;
    expect(revoke.url).toBe("https://api.github.com/applications/client-id/token");
    expect(JSON.parse(revoke.body)).toEqual({ access_token: "gho_owner_token" });

    const signedIn = new Request(`${SITE}/api/session`, { headers: { Cookie: `__Host-selfgit-session=${session}` } });
    expect(await currentUser(signedIn, config)).toEqual({ userId: Number(OWNER), login: "owner", avatarUrl: "https://avatars.example/o" });
  });

  test("any other GitHub account is refused and gets no session", async () => {
    const { config, sessions } = setup();
    const { location, flow } = await begin(config);
    const response = await finishLogin(callback({ code: CODE_OTHER, state: location.searchParams.get("state")! }, flow), config);
    expect(response.headers.get("Location")).toBe("/?signin=denied");
    expect(cookieValue(response, "__Host-selfgit-session")).toBeUndefined();
    expect(sessions.rows.size).toBe(0);
  });

  test("a wrong or missing state, a cancelled consent, and a bad code all fail closed", async () => {
    const { config, sessions } = setup();
    const { location, flow } = await begin(config);
    const state = location.searchParams.get("state")!;
    const outcome = async (request: Request) => (await finishLogin(request, config)).headers.get("Location");
    expect(await outcome(callback({ code: CODE_OWNER, state: "forged" }, flow))).toBe("/?signin=failed");
    expect(await outcome(callback({ code: CODE_OWNER, state }))).toBe("/?signin=expired");
    expect(await outcome(callback({ error: "access_denied", state }, flow))).toBe("/?signin=cancelled");
    expect(await outcome(callback({ code: "stolen", state }, flow))).toBe("/?signin=failed");
    expect(sessions.rows.size).toBe(0);
  });

  test("the post-login redirect stays on this site", async () => {
    for (const next of ["https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)"]) {
      const { config } = setup();
      const { location, flow } = await begin(config, next);
      const response = await finishLogin(callback({ code: CODE_OWNER, state: location.searchParams.get("state")! }, flow), config);
      expect(response.headers.get("Location")).toBe("/");
    }
  });

  test("sign-in is unavailable until the OAuth app is configured", async () => {
    const { config } = setup({ clientSecret: undefined });
    expect((await startLogin(new Request(`${SITE}/auth/github/login`), config)).status).toBe(503);
  });

  test("logout needs a same-origin POST and removes the session server-side", async () => {
    const { config, sessions } = setup();
    const { location, flow } = await begin(config);
    const login = await finishLogin(callback({ code: CODE_OWNER, state: location.searchParams.get("state")! }, flow), config);
    const cookie = `__Host-selfgit-session=${cookieValue(login, "__Host-selfgit-session")}`;

    expect((await logout(new Request(`${SITE}/auth/logout`, { headers: { Cookie: cookie } }), config)).status).toBe(405);
    const crossSite = new Request(`${SITE}/auth/logout`, { method: "POST", headers: { Cookie: cookie, Origin: "https://evil.example" } });
    expect((await logout(crossSite, config)).status).toBe(403);
    expect(sessions.rows.size).toBe(1);

    const response = await logout(new Request(`${SITE}/auth/logout`, { method: "POST", headers: { Cookie: cookie, Origin: SITE, "Sec-Fetch-Site": "same-origin" } }), config);
    expect(response.status).toBe(204);
    expect(response.headers.getSetCookie()[0]).toContain("Max-Age=0");
    expect(sessions.rows.size).toBe(0);
    expect(await currentUser(new Request(SITE, { headers: { Cookie: cookie } }), config)).toBeNull();
  });

  test("sessions expire, and a session for an earlier owner id no longer counts", async () => {
    let now = Date.UTC(2026, 10, 17);
    const { config } = setup({ now: () => now });
    const { location, flow } = await begin(config);
    const login = await finishLogin(callback({ code: CODE_OWNER, state: location.searchParams.get("state")! }, flow), config);
    const request = new Request(SITE, { headers: { Cookie: `__Host-selfgit-session=${cookieValue(login, "__Host-selfgit-session")}` } });
    expect(await currentUser(request, config)).not.toBeNull();
    expect(await currentUser(request, { ...config, ownerId: "42" })).toBeNull();
    now += 8 * 24 * 3600 * 1000;
    expect(await currentUser(request, config)).toBeNull();
  });
});
