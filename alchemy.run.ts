import { localState, Stack } from "alchemy";
import * as Effect from "effect/Effect";
import * as Cloudflare from "@alchemy.run/cloudflare";

/**
 * The main selfgit deployment, managed by alchemy.run (replacing wrangler).
 *  - name "selfgit" + custom domain git.oliinyk.dev
 *  - the R2 bucket is bound by name: alchemy never manages or reads it, so
 *    the deploy token needs no R2 permission
 *  - Durable Object classes keep their existing production state
 *    (script version updates never reset DO storage)
 *  - GITHUB_OAUTH_* secrets persist on the script across versions
 */
export default Stack(
  "selfgit",
  {
    providers: Cloudflare.providers(),
    state: localState(),
  } as never,
  Effect.gen(function* () {
    const worker = yield* Cloudflare.Worker("selfgit", {
      name: "selfgit",
      main: "./src/index.ts",
      compatibilityDate: "2026-11-01",
      compatibilityFlags: ["nodejs_compat"],
      workersDev: false,
      domain: "git.oliinyk.dev",
      env: {
        GITHUB_OWNER_ID: "85843900",
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

    yield* worker.bind`OBJECTS`({
      bindings: [
        { type: "r2_bucket", name: "OBJECTS", bucketName: "selfgit-objects" },
      ],
    });

    return { worker };
  }),
);
