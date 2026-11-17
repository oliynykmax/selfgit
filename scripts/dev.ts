import index from "../web/index.html";

const worker = process.env.SELFGIT_WORKER ?? "http://127.0.0.1:8787";

function proxy(request: Request) {
  const url = new URL(request.url);
  return fetch(worker + url.pathname + url.search, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: "manual",
  });
}

const server = Bun.serve({
  port: Number(process.env.PORT ?? 5173),
  development: true,
  routes: {
    "/theme-init.js": Bun.file("web/theme-init.js"),
    "/api/*": proxy,
    "/auth/*": proxy,
    "/*": index,
  },
});

console.log(`selfgit web on ${server.url}, API from ${worker}`);
