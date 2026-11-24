import { Buffer } from "node:buffer";
import { CorruptObject, isOid, type ObjectStore, ZERO_OID } from "./objects";
import { ByteInput } from "./byte-input";
import { ingestPack } from "./ingest";
import { writePack } from "./pack";
import {
  FLUSH,
  PktReader,
  ProtocolError,
  pkt,
  type Sideband,
  sideband,
} from "./pktline";

export type Service = "git-upload-pack" | "git-receive-pack";

const AGENT = "agent=selfgit-cloudflare/1";
const UPLOAD_CAPS = [
  "multi_ack_detailed",
  "side-band-64k",
  "side-band",
  "shallow",
  "no-progress",
  "include-tag",
  "object-format=sha1",
  AGENT,
];
const RECEIVE_CAPS = [
  "report-status",
  "delete-refs",
  "side-band-64k",
  "quiet",
  "atomic",
  "ofs-delta",
  "object-format=sha1",
  AGENT,
];
const DEFAULT_HEAD = "refs/heads/main";

/**
 * HEAD is the configured default branch while that branch exists. Otherwise it follows main, then master, then the
 * first branch, so clones check out whatever the course repo actually uses.
 */
export function headTarget(
  refs: Map<string, string>,
  configured: string | null = null,
): string {
  if (configured && refs.has(configured)) return configured;
  if (refs.has(DEFAULT_HEAD)) return DEFAULT_HEAD;
  if (refs.has("refs/heads/master")) return "refs/heads/master";
  return (
    [...refs.keys()].find((name) => name.startsWith("refs/heads/")) ??
    DEFAULT_HEAD
  );
}

interface Advertised {
  name: string;
  oid: string;
}

function advertisedRefs(
  store: ObjectStore,
  service: Service,
  configuredHead: string | null = null,
): { lines: Advertised[]; head: string | null } {
  const refs = store.refs();
  const lines: Advertised[] = [];
  const head = headTarget(refs, configuredHead);
  const headOid = refs.get(head);
  if (service === "git-upload-pack" && headOid)
    lines.push({ name: "HEAD", oid: headOid });
  for (const [name, oid] of refs) {
    lines.push({ name, oid });
    if (service === "git-upload-pack" && name.startsWith("refs/tags/")) {
      const peeled = store.peel(oid);
      if (peeled !== oid) lines.push({ name: `${name}^{}`, oid: peeled });
    }
  }
  return { lines, head: headOid ? head : null };
}

export function advertise(
  store: ObjectStore,
  service: Service,
  configuredHead: string | null = null,
): Buffer {
  const { lines, head } = advertisedRefs(store, service, configuredHead);
  const caps = [
    ...(service === "git-upload-pack" ? UPLOAD_CAPS : RECEIVE_CAPS),
  ];
  if (service === "git-upload-pack" && head) caps.push(`symref=HEAD:${head}`);
  const out = [pkt(`# service=${service}\n`), FLUSH];
  if (lines.length === 0)
    out.push(pkt(`${ZERO_OID} capabilities^{}\0${caps.join(" ")}\n`));
  lines.forEach(({ name, oid }, i) =>
    out.push(
      pkt(i === 0 ? `${oid} ${name}\0${caps.join(" ")}\n` : `${oid} ${name}\n`),
    ),
  );
  out.push(FLUSH);
  return Buffer.concat(out);
}

function sidebandMode(caps: Set<string>): Sideband {
  if (caps.has("side-band-64k")) return "side-band-64k";
  if (caps.has("side-band")) return "side-band";
  return null;
}

interface UploadRequest {
  wants: string[];
  caps: Set<string>;
  clientShallow: Set<string>;
  depth: number;
  haves: string[];
  /** False when the body ends after the want section: a stateless client collecting the shallow list. */
  negotiates: boolean;
  done: boolean;
}

function parseUploadRequest(body: Buffer): UploadRequest {
  const reader = new PktReader(body);
  const request: UploadRequest = {
    wants: [],
    caps: new Set(),
    clientShallow: new Set(),
    depth: 0,
    haves: [],
    negotiates: false,
    done: false,
  };
  for (let line = reader.readLine(); line !== null; line = reader.readLine()) {
    const [verb, arg = "", ...caps] = line.split(" ");
    if (verb === "want" && isOid(arg)) {
      if (request.wants.length === 0) request.caps = new Set(caps);
      request.wants.push(arg);
    } else if (verb === "shallow" && isOid(arg)) {
      request.clientShallow.add(arg);
    } else if (verb === "deepen" && /^\d+$/.test(arg)) {
      request.depth = Number(arg);
    } else {
      throw new ProtocolError(
        `unexpected line in upload-pack request: ${verb}`,
      );
    }
  }
  request.negotiates = !reader.done;
  while (!reader.done) {
    const line = reader.readLine();
    if (line === null) continue;
    if (line === "done") {
      request.done = true;
      break;
    }
    if (!line.startsWith("have ") || !isOid(line.slice(5)))
      throw new ProtocolError(`unexpected line in negotiation: ${line}`);
    request.haves.push(line.slice(5));
  }
  return request;
}

/** Walks commits from `starts`, treating `cut` commits as parentless (the client's shallow boundary). */
function walkCommits(
  store: ObjectStore,
  starts: Iterable<string>,
  cut: Set<string>,
  stop: Set<string> = new Set(),
): Set<string> {
  const seen = new Set<string>();
  const queue = [...starts];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid) || stop.has(oid)) continue;
    const info = store.info(oid);
    if (info?.type !== "commit") continue;
    seen.add(oid);
    if (!cut.has(oid)) queue.push(...info.links.slice(1));
  }
  return seen;
}

interface ShallowResult {
  shallow: string[];
  unshallow: string[];
  /** Commits whose parents must not be followed when building the pack. */
  cut: Set<string>;
  extraWants: string[];
}

/** Mirrors upload-pack's `deepen`: depth 1 is the wanted commit alone. */
function deepen(
  store: ObjectStore,
  wants: string[],
  depth: number,
  clientShallow: Set<string>,
): ShallowResult {
  const depthOf = new Map<string, number>();
  const boundary = new Set<string>();
  let frontier = wants
    .map((oid) => store.peel(oid))
    .filter((oid) => store.info(oid)?.type === "commit");
  for (let level = 1; frontier.length > 0; level++) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (depthOf.has(oid)) continue;
      depthOf.set(oid, level);
      const parents = store.info(oid)!.links.slice(1);
      if (level >= depth) {
        if (parents.length > 0) boundary.add(oid);
      } else {
        next.push(...parents);
      }
    }
    frontier = next;
  }
  const shallow = [...boundary].filter((oid) => !clientShallow.has(oid));
  const unshallow = [...clientShallow].filter(
    (oid) => depthOf.has(oid) && !boundary.has(oid),
  );
  const extraWants = unshallow.flatMap((oid) =>
    store.info(oid)!.links.slice(1),
  );
  return {
    shallow,
    unshallow,
    cut: new Set([...boundary, ...clientShallow]),
    extraWants,
  };
}

function collectObjects(
  store: ObjectStore,
  wants: string[],
  common: string[],
  cut: Set<string>,
  includeTag: boolean,
): string[] {
  const haveCommits = walkCommits(store, common, cut);
  const sent = new Set<string>();
  const order: string[] = [];
  const add = (oid: string) => {
    if (sent.has(oid)) return false;
    sent.add(oid);
    order.push(oid);
    return true;
  };

  const commitStarts: string[] = [];
  const looseStarts: string[] = [];
  for (const want of wants) {
    let oid = want;
    for (
      let info = store.info(oid);
      info?.type === "tag";
      info = store.info(oid)
    ) {
      add(oid);
      oid = info.links[0]!;
    }
    (store.info(oid)?.type === "commit" ? commitStarts : looseStarts).push(oid);
  }
  const commits = [...walkCommits(store, commitStarts, cut, haveCommits)];

  const uninteresting = new Set<string>();
  const markTree = (oid: string) => {
    if (uninteresting.has(oid)) return;
    uninteresting.add(oid);
    const info = store.info(oid);
    if (info?.type === "tree") info.links.forEach(markTree);
  };
  for (const oid of commits) {
    if (cut.has(oid)) continue;
    for (const parent of store.info(oid)!.links.slice(1)) {
      if (haveCommits.has(parent)) markTree(store.info(parent)!.links[0]!);
    }
  }
  for (const oid of common) {
    const info = store.info(oid);
    if (info?.type === "commit") markTree(info.links[0]!);
    else if (info) uninteresting.add(oid);
  }

  const addTree = (oid: string) => {
    if (uninteresting.has(oid) || !add(oid)) return;
    const info = store.info(oid);
    if (info?.type === "tree") info.links.forEach(addTree);
  };
  for (const oid of commits) {
    add(oid);
    addTree(store.info(oid)!.links[0]!);
  }
  for (const oid of looseStarts) addTree(oid);

  if (includeTag) {
    for (const [name, oid] of store.refs()) {
      if (!name.startsWith("refs/tags/") || sent.has(oid)) continue;
      const chain: string[] = [];
      let current = oid;
      for (
        let info = store.info(current);
        info?.type === "tag";
        info = store.info(current)
      ) {
        chain.push(current);
        current = info.links[0]!;
      }
      if (chain.length > 0 && sent.has(current)) chain.forEach(add);
    }
  }
  return order;
}

export async function uploadPack(
  store: ObjectStore,
  body: Buffer,
): Promise<ReadableStream<Uint8Array> | Buffer> {
  const request = parseUploadRequest(body);
  const { lines } = advertisedRefs(store, "git-upload-pack");
  const tips = new Set(lines.map((line) => line.oid));
  const bad = request.wants.find((oid) => !tips.has(oid));
  if (bad) return pkt(`ERR upload-pack: not our ref ${bad}\n`);

  const out: Buffer[] = [];
  let cut = new Set(request.clientShallow);
  let wants = request.wants;
  if (request.depth > 0) {
    const result = deepen(store, wants, request.depth, request.clientShallow);
    for (const oid of result.shallow) out.push(pkt(`shallow ${oid}\n`));
    for (const oid of result.unshallow) out.push(pkt(`unshallow ${oid}\n`));
    out.push(FLUSH);
    cut = result.cut;
    wants = [...wants, ...result.extraWants];
  }

  if (!request.negotiates) return Buffer.concat(out);
  const detailed = request.caps.has("multi_ack_detailed");
  const common: string[] = [];
  for (const oid of request.haves) if (await store.has(oid)) common.push(oid);
  for (const oid of common) {
    if (detailed) out.push(pkt(`ACK ${oid} common\n`));
    else if (oid === common[0]) out.push(pkt(`ACK ${oid}\n`));
  }
  if (!request.done) {
    if (detailed || common.length === 0) out.push(pkt("NAK\n"));
    return Buffer.concat(out);
  }
  if (common.length === 0) out.push(pkt("NAK\n"));
  else if (detailed) out.push(pkt(`ACK ${common[common.length - 1]}\n`));

  const objects = collectObjects(
    store,
    wants,
    common,
    cut,
    request.caps.has("include-tag"),
  );
  const mode = sidebandMode(request.caps);
  const pack = writePack(store, objects);
  const preamble = Buffer.concat(out);
  let started = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        started = true;
        controller.enqueue(preamble);
      }
      const batch: Buffer[] = [];
      let size = 0;
      for (let step = await pack.next(); ; step = await pack.next()) {
        if (step.done) {
          if (batch.length > 0) enqueue(controller, Buffer.concat(batch), mode);
          if (mode) controller.enqueue(FLUSH);
          controller.close();
          return;
        }
        batch.push(step.value);
        size += step.value.length;
        if (size >= 256 << 10) break;
      }
      enqueue(controller, Buffer.concat(batch), mode);
    },
  });
}

function enqueue(
  controller: ReadableStreamDefaultController<Uint8Array>,
  data: Buffer,
  mode: Sideband,
) {
  if (mode)
    for (const packet of sideband(1, data, mode)) controller.enqueue(packet);
  else controller.enqueue(data);
}

interface Command {
  old: string;
  new: string;
  ref: string;
}

/** The subset of check-ref-format rules receive-pack enforces on pushed names. */
export function validRefName(name: string): boolean {
  if (
    !name.startsWith("refs/") ||
    name.endsWith("/") ||
    name.endsWith(".") ||
    name.endsWith(".lock")
  )
    return false;
  if (
    [...name].some((char) => char <= " " || char === "\x7f") ||
    /[~^:?*[\\]|\.\.|@\{|\/\/|\/\./.test(name)
  )
    return false;
  return name
    .split("/")
    .every((part) => part.length > 0 && !part.startsWith("."));
}

/** A pushed object links to something neither the pack nor the repo holds. */
class MissingObjects extends Error {}

export async function receivePack(
  store: ObjectStore,
  transaction: (fn: () => void) => void,
  body: Buffer | ReadableStream<Uint8Array>,
  onUpdate?: (ref: string, oid: string) => void,
): Promise<Buffer> {
  const input = new ByteInput(body);
  const commands: Command[] = [];
  let caps = new Set<string>();
  for (
    let payload = await input.readPkt();
    payload !== null;
    payload = await input.readPkt()
  ) {
    const nul = payload.indexOf(0);
    const line = payload
      .toString("latin1", 0, nul === -1 ? payload.length : nul)
      .replace(/\n$/, "");
    if (nul !== -1)
      caps = new Set(
        payload
          .toString("latin1", nul + 1)
          .trim()
          .split(" "),
      );
    if (line.startsWith("shallow ")) continue;
    const [old = "", next = "", ref = ""] = line.split(" ");
    if (!isOid(old) || !isOid(next) || !ref)
      throw new ProtocolError(`malformed command: ${line}`);
    commands.push({ old, new: next, ref });
  }

  const results = new Map<string, string>();
  let unpack = "ok";
  try {
    if (commands.some((command) => command.new !== ZERO_OID))
      await ingestPack(store, input);
    const checked = new Set<string>();
    const pending = commands
      .filter((command) => command.new !== ZERO_OID)
      .map((command) => command.new);
    while (pending.length) {
      const oid = pending.pop()!;
      if (checked.has(oid)) continue;
      checked.add(oid);
      const info = store.info(oid);
      if (!info || !(await store.has(oid))) throw new MissingObjects();
      pending.push(...info.links);
    }
    transaction(() => {
      const refs = store.refs();
      for (const command of commands) {
        const current = refs.get(command.ref) ?? ZERO_OID;
        if (!validRefName(command.ref))
          results.set(command.ref, "funny refname");
        else if (results.has(command.ref))
          results.set(command.ref, "duplicate ref update");
        else if (current !== command.old)
          results.set(
            command.ref,
            `cannot lock ref '${command.ref}': is at ${current} but expected ${command.old}`,
          );
        else if (command.new !== ZERO_OID && !store.info(command.new))
          results.set(command.ref, "missing necessary objects");
        else results.set(command.ref, "ok");
      }
      const failed = [...results.values()].some((result) => result !== "ok");
      if (failed && caps.has("atomic")) {
        for (const [ref, result] of results)
          if (result === "ok") results.set(ref, "atomic push failed");
        return;
      }
      for (const command of commands)
        if (results.get(command.ref) === "ok") {
          store.setRef(command.ref, command.new);
          if (command.old !== command.new) onUpdate?.(command.ref, command.new);
        }
    });
  } catch (error) {
    if (error instanceof MissingObjects) {
      for (const command of commands)
        results.set(command.ref, "missing necessary objects");
    } else if (error instanceof CorruptObject) {
      unpack = error.message;
      for (const command of commands)
        results.set(command.ref, "unpacker error");
    } else {
      throw error;
    }
  }

  if (!caps.has("report-status")) return Buffer.alloc(0);
  const report = Buffer.concat([
    pkt(`unpack ${unpack}\n`),
    ...[...results].map(([ref, result]) =>
      pkt(result === "ok" ? `ok ${ref}\n` : `ng ${ref} ${result}\n`),
    ),
    FLUSH,
  ]);
  const mode = sidebandMode(caps);
  return mode ? Buffer.concat([...sideband(1, report, mode), FLUSH]) : report;
}
