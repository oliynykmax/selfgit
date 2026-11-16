import { Buffer } from "node:buffer";
import { DurableObject } from "cloudflare:workers";
import { CorruptObject, ObjectStore } from "./objects";
import { ProtocolError } from "./pktline";
import { advertise, receivePack, type Service, uploadPack } from "./protocol";

const NO_CACHE = { "Cache-Control": "no-cache, max-age=0, must-revalidate", Pragma: "no-cache", Expires: "Fri, 01 Jan 1980 00:00:00 GMT" };

async function readBody(request: Request): Promise<Buffer> {
  let body = request.body ?? new ReadableStream();
  const encoding = request.headers.get("Content-Encoding")?.toLowerCase();
  if (encoding === "gzip" || encoding === "x-gzip") body = body.pipeThrough(new DecompressionStream("gzip"));
  return Buffer.from(await new Response(body).arrayBuffer());
}

/** One bare repository: objects and refs in this Durable Object's SQLite storage. */
export class Repository extends DurableObject<Env> {
  private readonly store = new ObjectStore(this.ctx.storage.sql);

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const endpoint = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
    const service = (endpoint === "refs" ? url.searchParams.get("service") : endpoint) as Service;
    try {
      if (endpoint === "refs") {
        return new Response(advertise(this.store, service), {
          headers: { "Content-Type": `application/x-${service}-advertisement`, ...NO_CACHE },
        });
      }
      const body = await readBody(request);
      const result =
        service === "git-upload-pack"
          ? uploadPack(this.store, body)
          : receivePack(this.store, (fn) => this.ctx.storage.transactionSync(fn), body);
      return new Response(result, { headers: { "Content-Type": `application/x-${service}-result`, ...NO_CACHE } });
    } catch (error) {
      if (error instanceof ProtocolError || error instanceof CorruptObject) {
        return new Response(`${error.message}\n`, { status: 400, headers: { "Content-Type": "text/plain" } });
      }
      throw error;
    }
  }
}
