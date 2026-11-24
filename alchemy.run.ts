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
    const worker = yield* Cloudflare.Worker("selfgit-alchemy", {
      name: "selfgit-alchemy",
      main: "./src/index.ts",
      compatibilityDate: "2026-11-01",
      compatibilityFlags: ["nodejs_compat"],
      workersDev: true,
      env: {
        GITHUB_OWNER_ID: "85843900",
        // lookup binds the existing bucket without managing it:
        // read at plan time, never created/updated/deleted by alchemy.
        OBJECTS: Cloudflare.R2.Bucket.lookup({ name: "selfgit-objects" }),
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
