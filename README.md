# selfgit

Git server for school courses. Push weekly assignments here instead of creating new repos on GitHub.

It runs on Cloudflare Workers. Each repository (`repo1.git` through `repo10.git`) is one SQLite-backed Durable Object that stores Git objects and refs and speaks the Git smart HTTP protocol itself. Storage is persistent, unlike the old Railway container, which lost every repo on redeploy.

## Usage

Clone and fetch are public:

```bash
git clone https://git.oliinyk.dev/repo1.git
```

Push is tied to the owner's GitHub CLI login. Git sends a GitHub token as the HTTP Basic password. The Worker asks `https://api.github.com/user` whose token it is and accepts only the GitHub account with id `GITHUB_OWNER_ID` in `wrangler.jsonc` (85843900, `oliynykmax`). The id is checked, not the login name, because a login can be renamed and later claimed by someone else.

Give Git the token from `gh` for this host only:

```bash
git config --global credential.https://git.oliinyk.dev.helper ''
git config --global --add credential.https://git.oliinyk.dev.helper \
  '!f() { test "$1" = get && echo username=git && echo "password=$(gh auth token --hostname github.com)"; }; f'
git push origin main
```

The first line empties the helper list for `https://git.oliinyk.dev`, so a global `credential.helper store` or a keychain never saves the token. Other hosts keep their helpers. Drop `--global` and run both lines inside a clone to limit the helper to that one repo. `gh auth setup-git` cannot do this: it only configures hosts that `gh` itself is logged in to, such as `github.com`.

The token is fetched fresh on every push and never written to disk by Git. Clone and fetch send no credentials.

Shallow clones (`--depth`, `fetch --depth`, `--unshallow`), tags, branch deletion, force pushes, and atomic pushes work as they do against stock `git-http-backend`.

## Deploy

```bash
bun install
bun run deploy
```

There is no secret to set. `wrangler.jsonc` attaches the Worker to the custom domain `git.oliinyk.dev` and sets `GITHUB_OWNER_ID`. Find another account's id with `gh api user --jq .id`. The Worker refuses every push if the id is missing or not a number. The Railway image used a shared token and fell back to `changeme`.

## Moving from Railway

On 2026-11-16 the Railway project `selfgit` had no active deployment. Every past deployment showed as removed, the account's trial had expired, and `selfgit-production.up.railway.app` answered 404. The service had no volume, and the container kept repos only on its own disk, so no repository data survives to copy.

1. Deploy as above and check that `git ls-remote https://git.oliinyk.dev/repo1.git` answers.
2. Push each course repo from a local clone that still has its history:

   ```bash
   git remote set-url origin https://git.oliinyk.dev/repo1.git
   git push --all origin && git push --tags origin
   ```

3. If some other Git server still holds repos, `scripts/transfer.sh` mirrors every branch and tag and then compares the refs on both sides. It never writes to the source:

   ```bash
   scripts/transfer.sh https://old.example https://git.oliinyk.dev
   ```

   `SELFGIT_REPOS="repo1:repo1 repo3:repo7"` picks or renames repos.
4. The Railway project can be deleted from the Railway dashboard. Nothing on Cloudflare depends on it.

## Push authentication tradeoffs

- The `gh` token has the scopes `gh auth login` granted, typically `repo`, so the Worker receives a credential that can act on your GitHub account. It is sent only to `api.github.com` (redirects are not followed), cached only as a SHA-256 hash, and never logged by the Worker. To limit the exposure, push with a fine-grained personal access token that has no permissions instead: `/user` works with any valid token.
- A verified token is cached in the Worker isolate for 5 minutes, so a push makes one GitHub call instead of one per HTTP request. A revoked token keeps working for up to 5 minutes on an isolate that already cached it. Failed checks are not cached.
- Each check counts against the owner's own GitHub REST budget of 5,000 requests per hour.
- If GitHub is down, slow (over 5 s), or rate-limits the check, pushes fail with 503 and Git does not discard the credential. Clone and fetch never call GitHub and keep working.
- A wrong account gets 403. A missing or rejected token gets 401.

## Differences from the Railway server

- Push uses the owner's GitHub token instead of a shared `git:TOKEN` password.
- `GET /repoN.git/info/refs?service=git-receive-pack` now requires the push credentials too, not only the `POST`. Git asks for credentials one request earlier and pushes the same way.
- Repos have no configurable `HEAD`. It points at `main`, else `master`, else the first branch, so a clone checks out whatever branch the repo uses.
- The server speaks protocol v0. Git clients that ask for v2 fall back to it automatically.
- Not supported: the dumb HTTP protocol, `--shallow-since`, `--shallow-exclude`, `fetch --deepen=N`, push options, and partial clone filters. The old server did not enable filters either.
- Nothing is garbage-collected. Objects left unreachable by force pushes or deleted branches stay stored.

## Limits

These are Cloudflare Workers Free plan limits as documented on 2026-11-16.

- Request bodies are capped at 100 MB, which matches the old nginx `client_max_body_size`.
- A Durable Object has 128 MB of memory and 30 s of CPU per request. A push holds the whole pack plus the largest object's contents in memory, so a single file over roughly 40 MB may fail on Cloudflare. A 90 MB push worked under local `wrangler dev`, but the local runtime does not enforce the memory limit.
- Free accounts get 5 GB of Durable Object storage in total, 100,000 rows written per day, and 5,000,000 rows read per day. Each new object is one row written, and objects over 1 MiB compressed take one extra row per MiB. A clone of N objects reads a small multiple of N rows.

[Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/) hosts Git repos natively, and Containers could run the old image, but both require Workers Paid.

## Development

```bash
bun install
bun run typecheck
bun run test
```

`test/auth.test.ts` checks push authorization against a fake GitHub: owner, other account, rejected and missing tokens, outages, redirects, and caching. `test/git.test.ts` needs a logged-in `gh` (or `GH_TOKEN`), because its pushes verify a real token with GitHub through the credential helper above. It starts `wrangler dev` with persisted local state and drives it with the real `git` CLI: clone, push, fetch, thin packs with deltas, multi-megabyte binaries, tags, deletes, force and atomic pushes, gzip request bodies, the transfer script, and a runtime restart to prove persistence. The shallow-clone test runs the same steps against stock `git-http-backend` (`test/reference.ts`) and requires identical results.

Source layout:

- `src/index.ts` routes requests.
- `src/auth.ts` verifies push tokens with GitHub.
- `src/repo.ts` is the Durable Object that serves one repository.
- `src/protocol.ts` implements ref advertisement, upload-pack negotiation (including shallow), and receive-pack.
- `src/pack.ts` reads incoming packs, resolves deltas, and writes outgoing packs.
- `src/objects.ts` stores objects and refs in SQLite.
