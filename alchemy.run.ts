import { Stack, localState } from "alchemy";
import * as Effect from "effect/Effect";
import * as Cloudflare from "@alchemy.run/cloudflare";

/**
 * Parallel deployment of selfgit managed by alchemy.run instead of wrangler.
 * Same worker code (src/index.ts), same R2 bucket, fresh Durable Object
 * namespaces, served from *.workers.dev. wrangler flow stays untouched.
 */
export default Stack(
  "selfgit",
  {
    providers: Cloudflare.providers(),
    state: localState(),
  } as never,
  Effect.gen(function* () {
    // R2 bucket adopt requires R2 read during plan; disabled until the
    // token carries R2:Edit (see comment in env below).

    const worker = yield* Cloudflare.Worker("selfgit-alchemy", {
      name: "selfgit-alchemy",
      main: "./src/index.ts",
      compatibilityDate: "2026-11-01",
      compatibilityFlags: ["nodejs_compat"],
      workersDev: true,
      env: {
        GITHUB_OWNER_ID: "85843900",
        // OBJECTS: R2 binding temporarily off — current token lacks R2 read
        // (r2/buckets -> 403). Re-add once a token with R2:Edit is delivered.
        REPOS: Cloudflare.DurableObject("REPOS", {
          className: "Repository",
          storage: "sqlite",
        }),
        REGISTRY: Cloudflare.DurableObject("REGISTRY", {
          className: "Registry",
          storage: "sqlite",
        }),
        SESSIONS: Cloudflare.DurableObject("SESSIONS", {
          className: "Sessions",
          storage: "sqlite",
        }),
      } as never,
      assets: {
        directory: "./web/dist",
        notFoundHandling: "single-page-application",
        runWorkerFirst: true,
      },
    } as never);

    return { worker };
  }),
);
