import { Buffer } from "node:buffer";
import { DurableObject } from "cloudflare:workers";
import type { RepoName } from "./api-types";
import { Browser, NotFound } from "./browse";
import { CorruptObject, ObjectStore, ZERO_OID } from "./objects";
import { ProtocolError } from "./pktline";
import { advertise, headTarget, receivePack, type Service, uploadPack } from "./protocol";

const NO_CACHE = { "Cache-Control": "no-cache, max-age=0, must-revalidate", Pragma: "no-cache", Expires: "Fri, 01 Jan 1980 00:00:00 GMT" };

async function readBody(request: Request): Promise<Buffer> {
  let body = request.body ?? new ReadableStream();
  const encoding = request.headers.get("Content-Encoding")?.toLowerCase();
  if (encoding === "gzip" || encoding === "x-gzip") body = body.pipeThrough(new DecompressionStream("gzip"));
  return Buffer.from(await new Response(body).arrayBuffer());
}

export type Result<T> = { ok: true; value: T } | { ok: false; status: 400 | 404 | 409 | 413; error: string };

/** One bare repository: objects and refs in this Durable Object's SQLite storage. */
export class Repository extends DurableObject<Env> {
  private readonly store = new ObjectStore(this.ctx.storage.sql, this.env.OBJECTS, this.ctx.id.toString());

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
          ? await uploadPack(this.store, body)
          : await receivePack(this.store, (fn) => this.ctx.storage.transactionSync(fn), body);
      return new Response(result, { headers: { "Content-Type": `application/x-${service}-result`, ...NO_CACHE } });
    } catch (error) {
      if (error instanceof ProtocolError || error instanceof CorruptObject) {
        return new Response(`${error.message}\n`, { status: 400, headers: { "Content-Type": "text/plain" } });
      }
      throw error;
    }
  }

  private async browse<T>(read: (browser: Browser) => Promise<T>): Promise<Result<T>> {
    try {
      return { ok: true, value: await read(new Browser(this.store)) };
    } catch (error) {
      if (error instanceof NotFound) return { ok: false, status: 404, error: error.message };
      throw error;
    }
  }

  summary(name: RepoName) {
    return this.browse((browser) => browser.summary(name));
  }

  refs(name: RepoName) {
    return this.browse((browser) => browser.refs(name));
  }

  tree(revision: string, path: string) {
    return this.browse((browser) => browser.treeView(revision, path));
  }

  blob(revision: string, path: string) {
    return this.browse((browser) => browser.blobView(revision, path));
  }

  async raw(revision: string, path: string): Promise<Result<{ content: Uint8Array; binary: boolean }>> {
    const result = await this.browse((browser) => browser.raw(revision, path));
    if (!result.ok) return result;
    if (result.value === "too-large") return { ok: false, status: 413, error: "File is too large to view in the browser; clone the repository instead" };
    return { ok: true, value: result.value };
  }

  log(revision: string, path: string, page: number) {
    return this.browse((browser) => browser.log(revision, path, page));
  }

  commit(oid: string) {
    return this.browse((browser) => browser.commitView(oid));
  }

  /** Deletes a branch or tag. The branch HEAD follows is kept, as GitHub keeps the default branch. */
  deleteRef(ref: string): Result<null> {
    if (!/^refs\/(heads|tags)\/./.test(ref)) return { ok: false, status: 400, error: "Only branches and tags can be deleted" };
    return this.ctx.storage.transactionSync((): Result<null> => {
      const refs = this.store.refs();
      if (!refs.has(ref)) return { ok: false, status: 404, error: `${ref} does not exist` };
      if (ref === headTarget(refs)) return { ok: false, status: 409, error: "The default branch cannot be deleted" };
      this.store.setRef(ref, ZERO_OID);
      return { ok: true, value: null };
    });
  }
}
