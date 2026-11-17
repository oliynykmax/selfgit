import { CiQueue, MAIN, PIPELINE_REPO, type JobKind } from "./ci";
import { Buffer } from "node:buffer";
import { DurableObject } from "cloudflare:workers";
import type { RepoName } from "./api-types";
import { Browser, NotFound } from "./browse";
import {
  CorruptObject,
  deleteRepoObjects,
  ObjectStore,
  ZERO_OID,
} from "./objects";
import { ProtocolError } from "./pktline";
import { treeSnapshot } from "./tree-snapshot";
import {
  advertise,
  headTarget,
  receivePack,
  type Service,
  uploadPack,
} from "./protocol";

const NO_CACHE = {
  "Cache-Control": "no-cache, max-age=0, must-revalidate",
  Pragma: "no-cache",
  Expires: "Fri, 01 Jan 1980 00:00:00 GMT",
};

async function readBody(request: Request): Promise<Buffer> {
  let body = request.body ?? new ReadableStream();
  const encoding = request.headers.get("Content-Encoding")?.toLowerCase();
  if (encoding === "gzip" || encoding === "x-gzip")
    body = body.pipeThrough(new DecompressionStream("gzip"));
  return Buffer.from(await new Response(body).arrayBuffer());
}

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 404 | 409 | 413; error: string };

/** One bare repository: objects and refs in this Durable Object's SQLite storage. */
export class Repository extends DurableObject<Env> {
  private readonly store = new ObjectStore(
    this.ctx.storage.sql,
    this.env.OBJECTS,
    this.ctx.id.toString(),
  );

  private readonly ci = new CiQueue(this.ctx.storage.sql);

  private pending: Promise<void> = Promise.resolve();

  private deleted(): boolean {
    return (
      this.ctx.storage.sql.exec("SELECT 1 FROM repository_tombstone").toArray()
        .length > 0
    );
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.pending;
    let release!: () => void;
    this.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS repository_tombstone (deleted INTEGER NOT NULL)",
    );
  }

  async deleteRepository(): Promise<void> {
    if (!this.deleted())
      this.ctx.storage.sql.exec("INSERT INTO repository_tombstone VALUES (1)");
    await this.serialize(async () => {
      this.store.clearReadCache();
      await deleteRepoObjects(this.env.OBJECTS, this.ctx.id.toString());
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec("DELETE FROM refs");
        this.ctx.storage.sql.exec("DELETE FROM object_chunks");
        this.ctx.storage.sql.exec("DELETE FROM objects");
      });
    });
  }

  async maintenanceHashes(after: string) {
    return this.serialize(() => this.store.auditR2(after));
  }

  async maintenanceAudit() {
    return this.serialize(async () => {
      const sql = this.ctx.storage.sql;
      const objects = sql
        .exec<{ count: number; inline: number; bytes: number }>(
          "SELECT count(*) AS count, count(zdata) AS inline, coalesce(sum(length(zdata)), 0) AS bytes FROM objects",
        )
        .one();
      const chunks = sql
        .exec<{ count: number; bytes: number }>(
          "SELECT count(*) AS count, coalesce(sum(length(data)), 0) AS bytes FROM object_chunks",
        )
        .one();
      const refs = sql
        .exec<{ count: number }>("SELECT count(*) AS count FROM refs")
        .one().count;
      let r2Count = 0;
      let cursor: string | undefined;
      do {
        const page = await this.env.OBJECTS.list({
          prefix: `${this.ctx.id.toString()}/`,
          cursor,
        });
        r2Count += page.objects.length;
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return {
        id: this.ctx.id.toString(),
        deleted: this.deleted(),
        objects,
        chunks,
        refs,
        r2Count,
      };
    });
  }

  override async fetch(request: Request): Promise<Response> {
    return this.serialize(async () => {
      if (this.deleted()) return new Response("Not found\n", { status: 404 });
      return this.git(request);
    });
  }

  private async git(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const endpoint = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
    const service = (
      endpoint === "refs" ? url.searchParams.get("service") : endpoint
    ) as Service;
    try {
      if (endpoint === "refs") {
        return new Response(advertise(this.store, service), {
          headers: {
            "Content-Type": `application/x-${service}-advertisement`,
            ...NO_CACHE,
          },
        });
      }
      const body = await readBody(request);
      const result =
        service === "git-upload-pack"
          ? await uploadPack(this.store, body)
          : await receivePack(
              this.store,
              (fn) => this.ctx.storage.transactionSync(fn),
              body,
              (ref, oid) => {
                const name = url.pathname.split("/")[1]?.replace(/\.git$/, "");
                if (name === PIPELINE_REPO && ref === MAIN) {
                  if (oid === ZERO_OID)
                    throw new ProtocolError("Pipeline main cannot be deleted");
                  this.ci.enqueue(oid);
                }
              },
            );
      return new Response(result, {
        headers: {
          "Content-Type": `application/x-${service}-result`,
          ...NO_CACHE,
        },
      });
    } catch (error) {
      if (error instanceof ProtocolError || error instanceof CorruptObject) {
        return new Response(`${error.message}\n`, {
          status: 400,
          headers: { "Content-Type": "text/plain" },
        });
      }
      throw error;
    }
  }

  private async browse<T>(
    read: (browser: Browser) => Promise<T>,
  ): Promise<Result<T>> {
    return this.serialize(async () => {
      if (this.deleted())
        return { ok: false, status: 404, error: "Repository deleted" };
      try {
        return { ok: true, value: await read(new Browser(this.store)) };
      } catch (error) {
        if (error instanceof NotFound)
          return { ok: false, status: 404, error: error.message };
        throw error;
      }
    });
  }

  ciClaim(kind: JobKind) {
    return this.ctx.storage.transactionSync(() =>
      this.deleted() ? null : this.ci.claim(kind, Date.now()),
    );
  }
  ciLog(id: number, token: string, text: string) {
    return !this.deleted() && this.ci.log(id, token, text, Date.now());
  }
  ciHeartbeat(id: number, token: string) {
    return !this.deleted() && this.ci.heartbeat(id, token, Date.now());
  }
  ciFinish(id: number, token: string, success: boolean) {
    return !this.deleted() && this.ci.finish(id, token, success, Date.now());
  }
  ciRuns() {
    return this.deleted() ? [] : this.ci.runs();
  }

  summary(name: RepoName) {
    return this.browse((browser) => browser.summary(name));
  }

  refs(name: RepoName) {
    return this.browse((browser) => browser.refs(name));
  }

  tree(revision: string, path: string) {
    return this.browse((browser) =>
      treeSnapshot(
        browser,
        this.env.OBJECTS,
        this.ctx.id.toString(),
        revision,
        path,
      ),
    );
  }

  treeDescriptor(revision: string) {
    return this.browse(async (browser) => ({
      repoId: this.ctx.id.toString(),
      commit: browser.resolve(revision),
    }));
  }

  blob(revision: string, path: string) {
    return this.browse((browser) => browser.blobView(revision, path));
  }

  async raw(
    revision: string,
    path: string,
  ): Promise<Result<{ content: Uint8Array; binary: boolean }>> {
    const result = await this.browse((browser) => browser.raw(revision, path));
    if (!result.ok) return result;
    if (result.value === "too-large")
      return {
        ok: false,
        status: 413,
        error:
          "File is too large to view in the browser; clone the repository instead",
      };
    return { ok: true, value: result.value };
  }

  log(revision: string, path: string, page: number) {
    return this.browse((browser) => browser.log(revision, path, page));
  }

  commit(oid: string) {
    return this.browse((browser) => browser.commitView(oid));
  }

  /** Deletes a branch or tag. The branch HEAD follows is kept, as GitHub keeps the default branch. */
  async deleteRef(ref: string): Promise<Result<null>> {
    return this.serialize(async () => {
      if (this.deleted())
        return { ok: false, status: 404, error: "Repository deleted" };
      if (!/^refs\/(heads|tags)\/./.test(ref))
        return {
          ok: false,
          status: 400,
          error: "Only branches and tags can be deleted",
        };
      return this.ctx.storage.transactionSync((): Result<null> => {
        const refs = this.store.refs();
        if (!refs.has(ref))
          return { ok: false, status: 404, error: `${ref} does not exist` };
        if (ref === headTarget(refs))
          return {
            ok: false,
            status: 409,
            error: "The default branch cannot be deleted",
          };
        this.store.setRef(ref, ZERO_OID);
        return { ok: true, value: null };
      });
    });
  }
}
