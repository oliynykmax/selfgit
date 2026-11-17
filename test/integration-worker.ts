import { createHandler } from "../src/index";
import { GitHubIdentity } from "../src/auth";
import { finishLogin, startLogin, type OAuthConfig } from "../src/oauth";

import { Repository as BaseRepository } from "../src/repo";
const worker = createHandler(new GitHubIdentity(async (_url, init) => {
  const token = new Headers(init.headers).get("Authorization");
  return token === "Bearer test-owner-token" ? Response.json({ id: 12345 }) : new Response(null, { status: 401 });
}));
export { Registry, Sessions } from "../src/index";

export class Repository extends BaseRepository {
  private controls: { hold: boolean; entered: boolean; release?: () => void };
  constructor(ctx: DurableObjectState, env: Env) {
    const controls: { hold: boolean; entered: boolean; release?: () => void } = { hold: false, entered: false };
    const bucket = new Proxy(env.OBJECTS, {
      get(target, property) {
        if (property === "put") return async (...args: Parameters<R2Bucket["put"]>) => {
          if (controls.hold) {
            controls.entered = true;
            await new Promise<void>((resolve) => { controls.release = resolve; });
          }
          return target.put(...args);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    super(ctx, { ...env, OBJECTS: bucket });
    this.controls = controls;
  }
  holdWrites() { this.controls.hold = true; }
  writeEntered() { return this.controls.entered; }
  releaseWrites() { this.controls.hold = false; this.controls.release?.(); }
  async remaining() {
    const counts = ["refs", "objects", "object_chunks"].map((table) => this.ctx.storage.sql.exec<{ count: number }>(`SELECT count(*) AS count FROM ${table}`).one().count);
    const objects = await this.env.OBJECTS.list({ prefix: `${this.ctx.id.toString()}/` });
    return { counts, keys: objects.objects.map((object) => object.key) };
  }
}


export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/__test/")) {
      const repo = env.REPOS.getByName(new URL(request.url).searchParams.get("repo") ?? "race-delete") as unknown as DurableObjectStub<Repository>;
      if (path === "/__test/hold") await repo.holdWrites();
      if (path === "/__test/release") await repo.releaseWrites();
      if (path === "/__test/entered") return Response.json(await repo.writeEntered());
      if (path === "/__test/remaining") return Response.json(await repo.remaining());
      return new Response("ok");
    }
    if (path === "/auth/github/login" || path === "/auth/github/callback") {
      const auth: OAuthConfig = {
        clientId: "test-client",
        clientSecret: "test-secret",
        ownerId: env.GITHUB_OWNER_ID,
        sessions: env.SESSIONS.getByName("sessions"),
        waitUntil: (promise) => ctx.waitUntil(promise),
        fetcher: async (url) => {
          if (url === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "test-oauth-token" });
          if (url === "https://api.github.com/user") return Response.json({ id: Number(env.GITHUB_OWNER_ID), login: "owner" });
          return new Response(null, { status: 204 });
        },
      };
      return path.endsWith("/login") ? startLogin(request, auth) : finishLogin(request, auth);
    }
    return worker.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
