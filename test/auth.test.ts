import { describe, expect, test } from "bun:test";
import { denyPush, type Fetcher, GitHubIdentity } from "../src/auth";

const OWNER = "85843900";
const GOOD = "gho_owner";
const OTHER = "gho_someone_else";

function fakeGitHub(overrides: Partial<Record<string, () => Response>> = {}) {
  const calls: {
    url: string;
    authorization: string | null;
    redirect: RequestRedirect | undefined;
  }[] = [];
  const fetcher: Fetcher = async (url, init) => {
    const authorization = new Headers(init.headers).get("Authorization");
    calls.push({ url, authorization, redirect: init.redirect });
    const token = authorization?.replace(/^Bearer /, "") ?? "";
    const override = overrides[token];
    if (override) return override();
    if (token === GOOD)
      return Response.json({ id: Number(OWNER), login: "owner" });
    if (token === OTHER) return Response.json({ id: 1, login: "other" });
    return Response.json({ message: "Bad credentials" }, { status: 401 });
  };
  return { fetcher, calls };
}

function push(authorization?: string): Request {
  return new Request("https://git.example/repo1.git/git-receive-pack", {
    method: "POST",
    headers: authorization ? { Authorization: authorization } : {},
  });
}

const basic = (user: string, password: string) =>
  `Basic ${btoa(`${user}:${password}`)}`;

describe("push authorization against GitHub", () => {
  test("the owner's token is allowed under any username", async () => {
    const { fetcher, calls } = fakeGitHub();
    const identity = new GitHubIdentity(fetcher);
    expect(
      await denyPush(push(basic("git", GOOD)), OWNER, identity),
    ).toBeNull();
    expect(
      await denyPush(push(basic("anything", GOOD)), OWNER, identity),
    ).toBeNull();
    expect(calls[0]).toEqual({
      url: "https://api.github.com/user",
      authorization: `Bearer ${GOOD}`,
      redirect: "manual",
    });
  });

  test("another GitHub account is refused with 403", async () => {
    const denied = await denyPush(
      push(basic("git", OTHER)),
      OWNER,
      new GitHubIdentity(fakeGitHub().fetcher),
    );
    expect(denied?.status).toBe(403);
  });

  test("missing, empty, and GitHub-rejected credentials get a 401 challenge", async () => {
    const identity = new GitHubIdentity(fakeGitHub().fetcher);
    for (const header of [
      undefined,
      basic("git", ""),
      "Bearer gho_owner",
      basic("git", "gho_revoked"),
    ]) {
      const denied = await denyPush(push(header), OWNER, identity);
      expect(denied?.status).toBe(401);
      expect(denied?.headers.get("WWW-Authenticate")).toContain("Basic");
    }
  });

  test("a GitHub outage, rate limit, or redirect is 503, never an accepted push", async () => {
    const outages: Record<string, () => Response> = {
      down: () => new Response("", { status: 502 }),
      limited: () =>
        new Response("", {
          status: 403,
          headers: { "x-ratelimit-remaining": "0" },
        }),
      moved: () =>
        new Response("", {
          status: 302,
          headers: { Location: "https://evil.example/" },
        }),
      garbage: () => Response.json({ login: "no id" }),
    };
    const identity = new GitHubIdentity(fakeGitHub(outages).fetcher);
    for (const token of Object.keys(outages)) {
      expect(
        (await denyPush(push(basic("git", token)), OWNER, identity))?.status,
      ).toBe(503);
    }
    const unreachable = new GitHubIdentity(async () => {
      throw new TypeError("network down");
    });
    expect(
      (await denyPush(push(basic("git", GOOD)), OWNER, unreachable))?.status,
    ).toBe(503);
  });

  test("push is refused when no owner id is configured", async () => {
    const { fetcher, calls } = fakeGitHub();
    for (const owner of [undefined, "", "oliynykmax"]) {
      expect(
        (
          await denyPush(
            push(basic("git", GOOD)),
            owner,
            new GitHubIdentity(fetcher),
          )
        )?.status,
      ).toBe(503);
    }
    expect(calls).toHaveLength(0);
  });

  test("a verified token is cached for five minutes, failures are not cached", async () => {
    let now = 0;
    let githubDown = true;
    const { fetcher, calls } = fakeGitHub({
      [GOOD]: () =>
        githubDown
          ? new Response("", { status: 500 })
          : Response.json({ id: Number(OWNER) }),
    });
    const identity = new GitHubIdentity(fetcher, () => now);

    expect(await identity.resolve(GOOD)).toBe("unavailable");
    githubDown = false;
    expect(await identity.resolve(GOOD)).toEqual({ userId: Number(OWNER) });
    githubDown = true;
    now = 5 * 60_000 - 1;
    expect(await identity.resolve(GOOD)).toEqual({ userId: Number(OWNER) });
    expect(calls).toHaveLength(2);
    now = 5 * 60_000;
    expect(await identity.resolve(GOOD)).toBe("unavailable");
    expect(calls).toHaveLength(3);

    expect(await identity.resolve("gho_revoked")).toBe("invalid");
    expect(await identity.resolve("gho_revoked")).toBe("invalid");
    expect(calls).toHaveLength(5);
  });
});
