import { Buffer } from "node:buffer";
import { timingSafeEqual as bytesEqual } from "node:crypto";
import type { Fetcher } from "./auth";
import type { SessionStore, SessionUser } from "./sessions";

export const LOGIN_PATH = "/auth/github/login";
export const CALLBACK_PATH = "/auth/github/callback";
export const LOGOUT_PATH = "/auth/logout";

const FLOW_COOKIE = "__Host-selfgit-oauth";
const SESSION_COOKIE = "__Host-selfgit-session";
const FLOW_TTL_S = 10 * 60;
const SESSION_TTL_S = 7 * 24 * 60 * 60;
const GITHUB_TIMEOUT_MS = 10_000;
const GITHUB_HEADERS = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10", "User-Agent": "selfgit" };

export interface OAuthConfig {
  clientId: string | undefined;
  clientSecret: string | undefined;
  ownerId: string | undefined;
  fetcher: Fetcher;
  sessions: SessionStore;
  /** Runs work after the response, like revoking the GitHub token. */
  waitUntil: (promise: Promise<unknown>) => void;
  now?: () => number;
}

type SignInOutcome = "cancelled" | "expired" | "failed" | "denied";

function randomToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

async function sha256(value: string, encoding: "hex" | "base64url"): Promise<string> {
  return Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString(encoding);
}

function cookies(request: Request): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) jar.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return jar;
}

function setCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function redirect(location: string, setCookies: string[] = []): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  for (const value of setCookies) headers.append("Set-Cookie", value);
  return new Response(null, { status: 302, headers });
}

/** Only same-site absolute paths, so the post-login redirect can't leave the site. */
function safeNext(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  return value;
}

function configured(config: OAuthConfig): config is OAuthConfig & { clientId: string; clientSecret: string; ownerId: string } {
  return Boolean(config.clientId && config.clientSecret && config.ownerId && /^\d+$/.test(config.ownerId));
}

/** True for a request the site's own pages sent. Browsers send Origin on every cross-site and every non-GET request. */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  const site = request.headers.get("Sec-Fetch-Site");
  return origin === new URL(request.url).origin && (site === null || site === "same-origin");
}

export async function startLogin(request: Request, config: OAuthConfig): Promise<Response> {
  if (!configured(config)) return new Response("Sign-in is not configured\n", { status: 503 });
  const url = new URL(request.url);
  const state = randomToken();
  const verifier = randomToken();
  const next = Buffer.from(safeNext(url.searchParams.get("next"))).toString("base64url");
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: `${url.origin}${CALLBACK_PATH}`,
    state,
    code_challenge: await sha256(verifier, "base64url"),
    code_challenge_method: "S256",
    allow_signup: "false",
  }).toString();
  return redirect(authorize.toString(), [setCookie(FLOW_COOKIE, `${state}.${verifier}.${next}`, FLOW_TTL_S)]);
}

function timingSafeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && bytesEqual(left, right);
}

async function exchangeCode(config: OAuthConfig & { clientId: string; clientSecret: string }, code: string, verifier: string, redirectUri: string): Promise<string | null> {
  const response = await config.fetcher("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "selfgit" },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: redirectUri, code_verifier: verifier }).toString(),
    redirect: "manual",
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });
  if (response.status !== 200) return null;
  const token = ((await response.json()) as { access_token?: unknown }).access_token;
  return typeof token === "string" && token !== "" ? token : null;
}

async function fetchUser(config: OAuthConfig, token: string): Promise<SessionUser | null> {
  const response = await config.fetcher("https://api.github.com/user", {
    headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${token}` },
    redirect: "manual",
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });
  if (response.status !== 200) return null;
  const user = (await response.json()) as { id?: unknown; login?: unknown; avatar_url?: unknown };
  if (typeof user.id !== "number" || typeof user.login !== "string") return null;
  return { userId: user.id, login: user.login, avatarUrl: typeof user.avatar_url === "string" ? user.avatar_url : "" };
}

/** The token only proved who signed in. Revoking it means no usable GitHub credential outlives the callback. */
async function revokeToken(config: OAuthConfig & { clientId: string; clientSecret: string }, token: string): Promise<void> {
  await config.fetcher(`https://api.github.com/applications/${encodeURIComponent(config.clientId)}/token`, {
    method: "DELETE",
    headers: {
      ...GITHUB_HEADERS,
      Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ access_token: token }),
    redirect: "manual",
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });
}

export async function finishLogin(request: Request, config: OAuthConfig): Promise<Response> {
  const clearFlow = setCookie(FLOW_COOKIE, "", 0);
  const fail = (outcome: SignInOutcome) => redirect(`/?signin=${outcome}`, [clearFlow]);
  if (!configured(config)) return fail("failed");
  const url = new URL(request.url);
  const [state, verifier, next] = (cookies(request).get(FLOW_COOKIE) ?? "").split(".");
  if (!state || !verifier || next === undefined) return fail("expired");
  if (!timingSafeEqual(state, url.searchParams.get("state") ?? "")) return fail("failed");
  if (url.searchParams.get("error") === "access_denied") return fail("cancelled");
  const code = url.searchParams.get("code");
  if (!code) return fail("failed");

  let user: SessionUser | null;
  try {
    const token = await exchangeCode(config, code, verifier, `${url.origin}${CALLBACK_PATH}`);
    if (!token) return fail("failed");
    try {
      user = await fetchUser(config, token);
    } finally {
      config.waitUntil(revokeToken(config, token).catch(() => undefined));
    }
  } catch {
    return fail("failed");
  }
  if (!user) return fail("failed");
  if (user.userId !== Number(config.ownerId)) return fail("denied");

  const sessionId = randomToken();
  const now = (config.now ?? Date.now)();
  await config.sessions.create(await sha256(sessionId, "hex"), user, now + SESSION_TTL_S * 1000);
  const destination = safeNext(Buffer.from(next, "base64url").toString("utf8"));
  return redirect(destination, [clearFlow, setCookie(SESSION_COOKIE, sessionId, SESSION_TTL_S)]);
}

/** The signed-in owner, or null. A session for any other account, as after an owner change, counts as signed out. */
export async function currentUser(request: Request, config: OAuthConfig): Promise<SessionUser | null> {
  const sessionId = cookies(request).get(SESSION_COOKIE);
  if (!sessionId || !configured(config)) return null;
  const user = await config.sessions.get(await sha256(sessionId, "hex"), (config.now ?? Date.now)());
  return user && user.userId === Number(config.ownerId) ? user : null;
}

export async function logout(request: Request, config: OAuthConfig): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed\n", { status: 405, headers: { Allow: "POST" } });
  if (!sameOrigin(request)) return new Response("Cross-site request refused\n", { status: 403 });
  const sessionId = cookies(request).get(SESSION_COOKIE);
  if (sessionId) await config.sessions.delete(await sha256(sessionId, "hex"));
  return new Response(null, { status: 204, headers: { "Set-Cookie": setCookie(SESSION_COOKIE, "", 0), "Cache-Control": "no-store" } });
}
