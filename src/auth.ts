import { Buffer } from "node:buffer";

const GITHUB_USER_API = "https://api.github.com/user";
const CACHE_MS = 5 * 60_000;
const CACHE_ENTRIES = 256;
const GITHUB_TIMEOUT_MS = 5_000;

export type Identity = { userId: number } | "invalid" | "unavailable";

export type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

async function cacheKey(token: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Buffer.from(hash).toString("hex");
}

/**
 * Resolves a GitHub token to its account id by asking api.github.com, the only host a token is ever sent to.
 * Successful lookups are cached by token hash so one push costs one GitHub call, not one per HTTP request.
 */
export class GitHubIdentity {
  private readonly verified = new Map<
    string,
    { userId: number; expires: number }
  >();

  constructor(
    private readonly fetcher: Fetcher,
    private readonly now: () => number = Date.now,
  ) {}

  async resolve(token: string): Promise<Identity> {
    const key = await cacheKey(token);
    const cached = this.verified.get(key);
    if (cached && cached.expires > this.now()) return { userId: cached.userId };

    let response: Response;
    try {
      response = await this.fetcher(GITHUB_USER_API, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2026-03-10",
          "User-Agent": "selfgit",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      });
    } catch {
      return "unavailable";
    }
    if (response.status === 401) return "invalid";
    if (response.status !== 200) return "unavailable";
    const userId = ((await response.json()) as { id?: unknown }).id;
    if (typeof userId !== "number") return "unavailable";

    if (this.verified.size >= CACHE_ENTRIES) this.verified.clear();
    this.verified.set(key, { userId, expires: this.now() + CACHE_MS });
    return { userId };
  }
}

function basicPassword(header: string | null): string | null {
  if (!header?.toLowerCase().startsWith("basic ")) return null;
  const decoded = Buffer.from(header.slice(6).trim(), "base64").toString(
    "utf8",
  );
  const colon = decoded.indexOf(":");
  const password = colon === -1 ? "" : decoded.slice(colon + 1);
  return password || null;
}

const CHALLENGE = {
  "WWW-Authenticate":
    'Basic realm="selfgit push: GitHub token", charset="UTF-8"',
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

/**
 * Push credentials are HTTP Basic with any username and a GitHub token as the password.
 * Only the GitHub account whose immutable numeric id is `ownerId` may push. Returns null when allowed.
 */
export async function denyPush(
  request: Request,
  ownerId: string | undefined,
  identity: GitHubIdentity,
): Promise<Response | null> {
  if (!ownerId || !/^\d+$/.test(ownerId))
    return text(503, "Push is disabled: GITHUB_OWNER_ID is not configured");
  const token = basicPassword(request.headers.get("Authorization"));
  if (!token)
    return text(401, "Push requires a GitHub token as the password", CHALLENGE);
  const result = await identity.resolve(token);
  if (result === "invalid")
    return text(401, "GitHub rejected the token", CHALLENGE);
  if (result === "unavailable")
    return text(503, "Could not verify the token with GitHub, try again", {
      "Retry-After": "30",
    });
  if (result.userId !== Number(ownerId))
    return text(403, "This GitHub account may not push here");
  return null;
}
