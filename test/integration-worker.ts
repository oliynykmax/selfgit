import worker from "../src/index";
import { finishLogin, startLogin, type OAuthConfig } from "../src/oauth";

export { Repository, Registry, Sessions } from "../src/index";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;
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
