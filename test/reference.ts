import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "bun";


/**
 * Stock git-http-backend behind a minimal CGI bridge, as the Railway nginx config ran it.
 * Runs as its own process (`bun test/reference.ts <root> <repo>...`) because the tests block on git.
 */
function serve(root: string, repos: string[]) {
  mkdirSync(root, { recursive: true });
  for (const repo of repos) {
    spawnSync(["git", "init", "-q", "--bare", "-b", "main", join(root, `${repo}.git`)]);
    spawnSync(["git", "-C", join(root, `${repo}.git`), "config", "http.receivepack", "true"]);
  }
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const body = Buffer.from(await request.arrayBuffer());
      const cgi = spawn(["/usr/lib/git-core/git-http-backend"], {
        env: {
          PATH: process.env.PATH,
          HOME: root,
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: "",
          REQUEST_METHOD: request.method,
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          CONTENT_TYPE: request.headers.get("Content-Type") ?? "",
          CONTENT_LENGTH: String(body.length),
          HTTP_CONTENT_ENCODING: request.headers.get("Content-Encoding") ?? "",
          GIT_PROTOCOL: request.headers.get("Git-Protocol") ?? "",
          REMOTE_USER: "git",
        },
        stdin: body,
        stdout: "pipe",
      });
      const out = Buffer.from(await new Response(cgi.stdout).arrayBuffer());
      const split = out.indexOf("\r\n\r\n");
      const headers = new Headers();
      let status = 200;
      for (const line of out.toString("latin1", 0, split).split("\r\n")) {
        const [name = "", ...value] = line.split(": ");
        if (name.toLowerCase() === "status") status = Number.parseInt(value.join(": "), 10);
        else headers.append(name, value.join(": "));
      }
      return new Response(out.subarray(split + 4), { status, headers });
    },
  });
}

const [root, ...repos] = process.argv.slice(2);
if (!root) throw new Error("usage: bun test/reference.ts <root> <repo>...");
console.log(serve(root, repos).port);
