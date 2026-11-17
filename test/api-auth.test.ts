import { describe, expect, test } from "bun:test";
import { authorizeOwner } from "../src/api";
import { GitHubIdentity } from "../src/auth";
import type { OAuthConfig } from "../src/oauth";

const identity = new GitHubIdentity(async (_url, init) => {
  const token = new Headers(init.headers).get("Authorization");
  if (token === "Bearer owner") return Response.json({ id: 85843900 });
  if (token === "Bearer other") return Response.json({ id: 1 });
  return new Response(null, { status: 401 });
});
const auth = { ownerId: "85843900" } as OAuthConfig;
const request = (headers: Record<string, string>) =>
  new Request("https://git.example/api/repos", { method: "POST", headers });

describe("management authorization", () => {
  test("accepts only the owner's valid bearer token without a browser session", async () => {
    expect(
      await authorizeOwner(
        request({ Authorization: "Bearer owner" }),
        auth,
        identity,
      ),
    ).toBeNull();
    expect(
      (
        await authorizeOwner(
          request({ Authorization: "Bearer other" }),
          auth,
          identity,
        )
      )?.status,
    ).toBe(403);
    expect(
      (
        await authorizeOwner(
          request({ Authorization: "Bearer invalid" }),
          auth,
          identity,
        )
      )?.status,
    ).toBe(401);
    expect(
      (
        await authorizeOwner(
          request({ Authorization: "Basic owner" }),
          auth,
          identity,
        )
      )?.status,
    ).toBe(401);
  });
  test("rejects cross-site cookie requests before checking the session", async () => {
    expect(
      (
        await authorizeOwner(
          request({
            Origin: "https://evil.example",
            Cookie: "session=anything",
          }),
          auth,
          identity,
        )
      )?.status,
    ).toBe(403);
    expect(
      (
        await authorizeOwner(
          request({
            Origin: "https://git.example",
            "Sec-Fetch-Site": "cross-site",
            Cookie: "session=anything",
          }),
          auth,
          identity,
        )
      )?.status,
    ).toBe(403);
  });
});
