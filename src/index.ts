import { Buffer } from "node:buffer";

export { Repository } from "./repo";

const ROUTE = /^\/(repo(?:[1-9]|10))\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const PUSH_USER = "git";

function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(`${body}\n`, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...headers } });
}

async function digest(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}

/** Push credentials are HTTP Basic `git:<GIT_TOKEN>`, as the Railway nginx htpasswd file required. */
async function canPush(request: Request, token: string | undefined): Promise<boolean> {
  const header = request.headers.get("Authorization") ?? "";
  if (!token || !header.toLowerCase().startsWith("basic ")) return false;
  const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon === -1 || decoded.slice(0, colon) !== PUSH_USER) return false;
  const [given, expected] = await Promise.all([digest(decoded.slice(colon + 1)), digest(token)]);
  return crypto.subtle.timingSafeEqual(given, expected);
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
    if (service === "git-receive-pack" && !(await canPush(request, env.GIT_TOKEN))) {
      return text(401, "Push requires authentication", { "WWW-Authenticate": 'Basic realm="Push", charset="UTF-8"' });
    }
    return env.REPOS.getByName(repo).fetch(request);
  },
} satisfies ExportedHandler<Env>;
