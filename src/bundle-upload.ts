import { Buffer } from "node:buffer";

/** R2 multipart parts must be at least 5 MiB and all the same size except the last. */
export const UPLOAD_PART_BYTES = 8 << 20;
/** Parts in flight at once, so reading the request body does not stop while a part uploads. */
const PARALLEL_PARTS = 3;

/**
 * Writes a payload of unknown length to R2 without holding it in memory. Payloads smaller than one
 * part never start an upload and come back whole, so the caller can store them with other objects.
 */
export class BundleUpload {
  private parts: Uint8Array[] = [];
  private pending = 0;
  private upload: R2MultipartUpload | undefined;
  private readonly uploaded: R2UploadedPart[] = [];
  private inflight: Promise<R2UploadedPart>[] = [];
  private partCount = 0;
  length = 0;

  constructor(
    private readonly bucket: R2Bucket,
    readonly key: string,
  ) {}

  async write(chunk: Uint8Array): Promise<void> {
    this.parts.push(chunk);
    this.pending += chunk.length;
    this.length += chunk.length;
    while (this.pending >= UPLOAD_PART_BYTES) await this.sendPart(false);
  }

  private async sendPart(final: boolean): Promise<void> {
    const all =
      this.parts.length === 1 ? this.parts[0]! : Buffer.concat(this.parts);
    const size = final ? all.length : UPLOAD_PART_BYTES;
    const rest = all.subarray(size);
    this.upload ??= await this.bucket.createMultipartUpload(this.key);
    const upload = this.upload.uploadPart(
      ++this.partCount,
      all.subarray(0, size),
    );
    upload.catch(() => {});
    this.inflight.push(upload);
    this.parts = rest.length > 0 ? [rest] : [];
    this.pending = rest.length;
    if (this.inflight.length >= PARALLEL_PARTS)
      this.uploaded.push(await this.inflight.shift()!);
  }

  async finish(): Promise<
    { inline: Buffer } | { key: string; length: number }
  > {
    if (!this.upload) return { inline: Buffer.concat(this.parts) };
    if (this.pending > 0) await this.sendPart(true);
    while (this.inflight.length > 0)
      this.uploaded.push(await this.inflight.shift()!);
    await this.upload.complete(this.uploaded);
    return { key: this.key, length: this.length };
  }

  async abort(): Promise<void> {
    this.parts = [];
    this.pending = 0;
    await Promise.allSettled(this.inflight);
    this.inflight = [];
    try {
      await this.upload?.abort();
    } catch {
      // The upload is abandoned either way, and R2 expires incomplete uploads.
    }
  }
}
