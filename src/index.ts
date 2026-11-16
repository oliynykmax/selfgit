import { denyPush, GitHubIdentity } from "./auth";

export { Repository } from "./repo";

const ROUTE = /^\/(repo(?:[1-9]|10))\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const identity = new GitHubIdentity((input, init) => fetch(input, init));

function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(`${body}\n`, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...headers } });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const match = ROUTE.exec(url.pathname);
    if (!match) return text(404, "Not found");
    const repo = match[1]!;
    const endpoint = match[2]!;
    const service = endpoint === "info/refs" ? url.searchParams.get("service") : endpoint;
    if (service !== "git-upload-pack" && service !== "git-receive-pack") {
      return text(403, "Only the smart HTTP protocol is supported");
    }
    const method = endpoint === "info/refs" ? "GET" : "POST";
    if (request.method !== method && !(method === "GET" && request.method === "HEAD")) {
      return text(405, "Method not allowed", { Allow: method });
    }
    if (service === "git-receive-pack") {
      const denied = await denyPush(request, env.GITHUB_OWNER_ID, identity);
      if (denied) return denied;
    }
    return env.REPOS.getByName(repo).fetch(request);
  },
} satisfies ExportedHandler<Env>;
