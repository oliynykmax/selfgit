import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import globalJsdom from "global-jsdom";

const nativeGlobals = {
  fetch: globalThis.fetch,
  Event: globalThis.Event,
  AbortController: globalThis.AbortController,
  AbortSignal: globalThis.AbortSignal,
};
const restoreGlobals = globalJsdom(undefined, {
  url: "https://git.example/course-work",
  pretendToBeVisual: true,
});
globalThis.Event = window.Event;
globalThis.AbortController = window.AbortController;
globalThis.AbortSignal = window.AbortSignal;
HTMLElement.prototype.showPopover = function () {};
HTMLElement.prototype.hidePopover = function () {};
Element.prototype.getAnimations = () => [];
Element.prototype.scrollIntoView = function () {};
Element.prototype.checkVisibility = () => true;
Element.prototype.getClientRects = () => [] as unknown as DOMRectList;
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
document.elementFromPoint = () => null;
document.elementsFromPoint = () => [];
document.head.append(
  Object.assign(document.createElement("style"), {
    textContent: "[popover] { display: block !important }",
  }),
);
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = false;
(globalThis as { __UI_SDK_STRICT__?: boolean }).__UI_SDK_STRICT__ = true;

const { cleanup, render, screen } = await import("@testing-library/react");
const { createAgent } = await import("@ui-sdk/react/agent");
const { renderMarkdown, resolvePath } = await import("../web/src/lib/markdown");
const { parseRoute, splitRefPath, href } = await import("../web/src/lib/route");
const { RefPicker } = await import("../web/src/components/ref-picker");
const { DeleteRef } = await import("../web/src/components/delete-ref");

let approve = false;
const agent = createAgent({ allow: (step) => !step.confirm || approve });

afterEach(cleanup);
afterAll(() => {
  restoreGlobals();
  Object.assign(globalThis, nativeGlobals);
});

const commit = {
  oid: "a".repeat(40),
  parents: [],
  author: { name: "A", email: "a@x", time: 1, tz: "+0000" },
  committer: { name: "A", email: "a@x", time: 1, tz: "+0000" },
  subject: "s",
};
const refs = {
  name: "course-work" as const,
  defaultBranch: "main",
  branches: [
    { name: "main", commit },
    { name: "feature/reverse", commit },
  ],
  tags: [{ name: "v1.0", commit }],
};

describe("routes", () => {
  test("URLs parse into views, and refs with slashes split by the longest known ref", () => {
    expect(parseRoute("/")).toEqual({ kind: "home" });
    expect(parseRoute("/course-work")).toEqual({
      kind: "tree",
      repo: "course-work",
      rest: [],
    });
    expect(parseRoute("/course-work/blob/feature/reverse/src/a%20b.c")).toEqual(
      {
        kind: "blob",
        repo: "course-work",
        rest: ["feature", "reverse", "src", "a b.c"],
      },
    );
    expect(parseRoute("/course-work/commit/" + "f".repeat(40))).toEqual({
      kind: "commit",
      repo: "course-work",
      oid: "f".repeat(40),
    });
    expect(parseRoute("/course-work/commit/nothex")).toEqual({
      kind: "not-found",
    });
    expect(parseRoute("/invalid%20name")).toEqual({ kind: "not-found" });
    expect(parseRoute("/selfgit/actions")).toEqual({
      kind: "actions",
      repo: "selfgit",
    });
    expect(parseRoute("/selfgit/actions/45")).toEqual({
      kind: "run",
      repo: "selfgit",
      id: 45,
    });
    expect(parseRoute("/selfgit/actions/x")).toEqual({ kind: "not-found" });
    expect(parseRoute("/course-work/actions")).toEqual({ kind: "not-found" });
    expect(
      splitRefPath(
        ["feature", "reverse", "src", "a.c"],
        ["feature", "feature/reverse"],
      ),
    ).toEqual({ ref: "feature/reverse", path: "src/a.c" });
    expect(splitRefPath(["main"], ["main"])).toEqual({ ref: "main", path: "" });
    expect(splitRefPath(["nope", "x"], ["main"])).toBeNull();
    expect(href.blob("course-work", "feature/reverse", "src/a b.c")).toBe(
      "/course-work/blob/feature/reverse/src/a%20b.c",
    );
  });
});

describe("README rendering", () => {
  const resolve = {
    link: (path: string) => `/course-work/blob/main/${path}`,
    image: (path: string) => `/raw/${path}`,
  };

  test("hostile HTML in a README is stripped", () => {
    const html = renderMarkdown(
      '<script>alert(1)</script><img src=x onerror="alert(2)"><a href="javascript:alert(3)">x</a><iframe src="https://evil"></iframe><div style="position:fixed">y</div><form action="/auth/logout"><button>z</button></form>',
      "",
      resolve,
    );
    const root = document.createElement("div");
    root.innerHTML = html;
    expect(
      root.querySelector("script, iframe, form, button, [onerror], [style]"),
    ).toBeNull();
    expect(root.querySelector("a")?.getAttribute("href") ?? null).toBeNull();
  });

  test("relative links and images point into the repository; external links open safely", () => {
    const root = document.createElement("div");
    root.innerHTML = renderMarkdown(
      "[n](../notes.md#top) [abs](/docs/a.md) [ext](https://example.com) ![i](img/a.png)\n\n- [x] done",
      "docs/week1",
      resolve,
    );
    const links = [...root.querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/course-work/blob/main/docs/notes.md#top",
      "/course-work/blob/main/docs/a.md",
      "https://example.com",
    ]);
    expect(links[2]!.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    expect(root.querySelector("img")!.getAttribute("src")).toBe(
      "/raw/docs/week1/img/a.png",
    );
    expect(
      root.querySelector("input[type=checkbox]")!.hasAttribute("disabled"),
    ).toBe(true);
    expect(resolvePath("a/b", "../../../x")).toBe("x");
  });
});

describe("agent-ready controls", () => {
  test("an agent can find the branch picker and switch branches", async () => {
    const changes: string[] = [];
    render(
      <RefPicker
        refs={refs}
        current="main"
        onChange={(ref) => changes.push(ref)}
      />,
    );
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
    const entries = agent
      .snapshot()
      .filter((entry) => !entry.offPage && entry.component !== "more");
    for (const entry of entries)
      expect(
        entry.label,
        `${entry.component} ${entry.ref} has no name`,
      ).toBeTruthy();
    expect(entries.map((entry) => entry.label)).toContain(
      "Switch branch or tag",
    );
    const result = await agent.act({
      steps: [
        {
          ref: "Switch branch or tag",
          action: "setValue",
          args: ["feature/reverse"],
        },
      ],
    });
    expect(result.ok, result.error?.message).toBe(true);
    expect(changes).toEqual(["feature/reverse"]);
  });

  test("deleting a branch needs a person's confirmation, then calls the API", async () => {
    const calls: { url: string; method: string }[] = [];
    globalThis.fetch = mock(
      async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), method: init?.method ?? "GET" });
        return new Response(null, { status: 200 });
      },
    ) as unknown as typeof fetch;
    render(
      <DeleteRef repo="course-work" kind="branch" name="feature/reverse" />,
    );
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
    expect(
      agent
        .snapshot()
        .some(
          (entry) =>
            !entry.offPage && entry.label === "Delete branch feature/reverse",
        ),
    ).toBe(true);
    const remove = {
      steps: [
        {
          ref: "Delete branch feature/reverse",
          action: "press",
          args: ["Yes, delete"],
        },
      ],
    };

    approve = false;
    expect((await agent.act(remove)).ok).toBe(false);
    expect(calls).toEqual([]);

    approve = true;
    const result = await agent.act(remove);
    expect(result.ok, result.error?.message).toBe(true);
    expect(calls).toEqual([
      {
        url: "/api/repos/course-work/refs?name=refs%2Fheads%2Ffeature%2Freverse",
        method: "DELETE",
      },
    ]);
    expect(screen.queryByText(/Delete branch/)).toBeNull();
  });
});
