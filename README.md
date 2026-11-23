<p align="center">
  <a href="https://git.oliinyk.dev">
    <img src="web/favicon.svg" alt="selfgit logo" width="72" height="72">
  </a>
</p>
<h1 align="center">selfgit</h1>
<p align="center">A small, personal Git server that runs entirely on Cloudflare Workers.</p>
<p align="center">
  <a href="https://git.oliinyk.dev"><img alt="Live at git.oliinyk.dev" src="https://img.shields.io/badge/live-git.oliinyk.dev-black?style=flat-square"></a>
  <a href="https://developers.cloudflare.com/workers/"><img alt="Cloudflare Workers" src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white"></a>
  <a href="https://bun.com"><img alt="Built with Bun" src="https://img.shields.io/badge/built%20with-Bun-000?style=flat-square&logo=bun"></a>
</p>

---

Push course work and side projects to your own domain instead of opening yet another GitHub repo. Anyone can clone. Only you can push, signed in with the GitHub CLI you already use.

- **Real Git.** Smart HTTP clone, fetch and push, including shallow clones, tags, force and atomic pushes, and branch deletion.
- **Durable storage.** Each repository is a Durable Object holding refs and object metadata in SQLite. Object payloads live in R2.
- **A web UI.** Browse code, commits, diffs and branches, with rendered READMEs, light and dark themes.
- **No passwords.** Pushes are checked against your GitHub account id. Nothing secret is stored on the server.
- **Free plan.** Runs on the Cloudflare Workers Free plan.

### Use it

Clone and fetch need no credentials:

```bash
git clone https://git.oliinyk.dev/selfgit.git
```

To push, let Git ask `gh` for a token, for this host only:

```bash
git config --global credential.https://git.oliinyk.dev.helper ''
git config --global --add credential.https://git.oliinyk.dev.helper \
  '!f() { test "$1" = get && echo username=git && echo "password=$(gh auth token --hostname github.com)"; }; f'
```

The first line clears any stored helper for this host, so the token is fetched fresh on every push and never saved to disk.

Create a repository from the web UI after signing in, or from the terminal:

```bash
curl -X POST https://git.oliinyk.dev/api/repos \
  -H "Authorization: Bearer $(gh auth token)" -d '{"name":"week1"}'
```

Moving repositories from another Git server? `scripts/transfer.sh <source> <selfgit>` mirrors every branch and tag and compares the refs on both sides. It never writes to the source.

### Deploy your own

```bash
bun install
bun run deploy
```

Then, in [`wrangler.jsonc`](wrangler.jsonc):

1. Set `GITHUB_OWNER_ID` to your numeric GitHub id (`gh api user --jq .id`). The id is checked, not the login, because a login can be renamed and claimed by someone else.
2. Point `routes` at your own domain.
3. Add `GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET` as Worker secrets for web sign-in.

### Develop

```bash
bun install
bun run dev       # build the web app and run the Worker on :8787
bun run dev:web   # web UI with hot reload on :5173, API proxied to :8787
bun run ci        # bun check, bun lint, bun fmt --check, every test
```

Everything runs on [Bun](https://bun.com). Bun bundles the React and Tailwind web app, `bun check` type checks, `bun lint` and `bun fmt` keep the code tidy, and `bun test` runs the suite. The Git integration tests start `wrangler dev` and drive it with the real `git` CLI. The shallow-clone test runs the same steps against stock `git-http-backend` and requires identical results.

| Path                                 | What lives there                                            |
| ------------------------------------ | ----------------------------------------------------------- |
| [`src/index.ts`](src/index.ts)       | Request routing                                             |
| [`src/repo.ts`](src/repo.ts)         | The Durable Object that serves one repository               |
| [`src/protocol.ts`](src/protocol.ts) | Ref advertisement, upload-pack negotiation and receive-pack |
| [`src/pack.ts`](src/pack.ts)         | Reading, resolving and writing packfiles                    |
| [`src/objects.ts`](src/objects.ts)   | Object storage in R2 and SQLite                             |
| [`src/auth.ts`](src/auth.ts)         | Push authorization against GitHub                           |
| [`src/ci.ts`](src/ci.ts)             | The CI job queue                                            |
| [`web/`](web)                        | The web UI                                                  |
| [`runner/`](runner)                  | The self-hosted CI runner                                   |

### CI

Every push to the `main` branch of selfgit's own repository queues a CI job. [`runner/runner.py`](runner/runner.py) polls the Worker for jobs, checks out the commit in an isolated [proot](https://github.com/termux/proot-distro) Debian guest, and runs `bun run ci`. The runner lives on an Android phone in Termux. Android kernels have a 39-bit address space, which the stock workerd allocator can't handle, so the tests use workerd [built without tcmalloc](https://github.com/oliynykmax/workerd-arm64-39bit).

A second runner can run on any aarch64 Linux host with rootless Podman: build `runner/Containerfile`, then start `runner.py` with `SELFGIT_CI_BACKEND=podman`. It runs each job in a container limited by `SELFGIT_CI_MEMORY` (default 1536m) and `SELFGIT_CI_CPUS` (default 1), and uses stock workerd.

<details>
<summary><strong>Push authentication tradeoffs</strong></summary>

- The `gh` token usually has the `repo` scope, so the Worker receives a credential that could act on your GitHub account. It is sent only to `api.github.com`, cached only as a SHA-256 hash, and never logged. To limit exposure, push with a fine-grained token that has no permissions. `/user` works with any valid token.
- A verified token is cached for 5 minutes per isolate, so a revoked token can keep working that long. Failed checks are not cached.
- Each check counts against your GitHub REST budget of 5,000 requests per hour.
- If GitHub is down, slow (over 5 s) or rate limiting, pushes fail with 503. Clone and fetch never call GitHub.
- A wrong account gets 403. A missing or rejected token gets 401.

</details>

<details>
<summary><strong>Protocol support</strong></summary>

- The server speaks protocol v0. Clients that ask for v2 fall back automatically.
- `HEAD` points at `main`, else `master`, else the first branch.
- Not supported: the dumb HTTP protocol, `--shallow-since`, `--shallow-exclude`, `fetch --deepen`, push options and partial clone filters.
- Nothing is garbage collected. Objects left unreachable by force pushes or deleted branches stay stored.

</details>

<details>
<summary><strong>Limits</strong></summary>

These are Cloudflare Workers Free plan limits.

- Request bodies are capped at 100 MB, so a push of one file can be up to about 99 MB. Anything larger is refused with HTTP 413 before it reaches the Worker.
- A Durable Object has 128 MB of memory. Pushes and clones stream, so file size does not use it. Blobs over 1 MB go to R2 as a multipart upload while they arrive, and clones copy them back as a stream.
- A delta, a delta base, a tree or a commit has to fit in 32 MB. When a push edits a file whose previous version is larger than that, git sends a delta that selfgit refuses, and the error says to push it without deltas: `git -c pack.window=0 push`.
- Selfgit serves one request per repository at a time, so a large push makes every other push and clone of that repository wait until it finishes.
- R2 has a monthly free allowance for storage and operations. See [R2 pricing](https://developers.cloudflare.com/r2/pricing/) and [R2 limits](https://developers.cloudflare.com/r2/platform/limits/).

</details>
