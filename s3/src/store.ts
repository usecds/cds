import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ClientConfig
} from "@aws-sdk/client-s3";
import type { ChannelManifest, ObjectStore, ReleaseManifest } from "@usecds/server";

export interface S3StoreConfig {
  bucket: string;
  /** The project's folder in the bucket ("hotelplatform"); empty for the bucket's root */
  prefix?: string;
  /** An S3-compatible server's URL (SeaweedFS, RustFS, Ceph); omit for AWS */
  endpoint?: string;
  region?: string;
  /** Omit to use the standard AWS environment (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, profiles) */
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  /** Path-style URLs (endpoint/bucket/key); most self-hosted servers need it. Default: true with an endpoint */
  forcePathStyle?: boolean;
  /** An S3 client of your own instead (the other connection options are then ignored) */
  client?: S3Client;
}

// Content-addressed files never change; the channel manifest does (the commit point)
const IMMUTABLE = "public, max-age=31536000, immutable";
const NO_CACHE = "no-cache";

const MEDIA_TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webm": "video/webm",
  ".webp": "image/webp"
};

// Stores map characters outside [a-zA-Z0-9_-] in release IDs and channel names to "_"
const safe = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_");

const notFound = (err: unknown) => {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404;
};

/**
 * A CDS store in an S3 bucket, under a prefix: the layout FilesystemStore writes
 * (channels/, releases/, objects/, media/), so any static reader works on it. Content-addressed
 * files are written once (an existing one is skipped) with an immutable cache header; channel
 * manifests are written last by the publisher and never cached. Node only.
 */
export class S3Store implements ObjectStore {
  readonly bucket: string;
  readonly prefix: string;
  private readonly s3: S3Client;

  constructor(config: S3StoreConfig) {
    this.bucket = config.bucket;
    this.prefix = (config.prefix ?? "").replace(/^\/+|\/+$/g, "");
    const options: S3ClientConfig = {
      region: config.region ?? process.env.AWS_REGION ?? "us-east-1",
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      forcePathStyle: config.forcePathStyle ?? Boolean(config.endpoint),
      ...(config.credentials ? { credentials: config.credentials } : {})
    };
    this.s3 = config.client ?? new S3Client(options);
  }

  /** s3://bucket/prefix, with the connection from the AWS environment (AWS_ENDPOINT_URL for a self-hosted server) */
  static fromUrl(url: string, config: Omit<S3StoreConfig, "bucket" | "prefix"> = {}): S3Store {
    const match = /^s3:\/\/([^/]+)\/?(.*)$/.exec(url);
    if (!match) throw new Error(`Not an S3 URL: ${url} (expected s3://<bucket>/<prefix>)`);
    const endpoint = config.endpoint ?? process.env.AWS_ENDPOINT_URL_S3 ?? process.env.AWS_ENDPOINT_URL;
    return new S3Store({ ...config, ...(endpoint ? { endpoint } : {}), bucket: match[1]!, prefix: match[2] ?? "" });
  }

  private key(relative: string) {
    return this.prefix ? `${this.prefix}/${relative}` : relative;
  }

  private async put(relative: string, body: string | Buffer, contentType: string, cacheControl: string) {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.key(relative), Body: body, ContentType: contentType, CacheControl: cacheControl }));
  }

  private async size(relative: string): Promise<number | null> {
    try {
      const head = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(relative) }));
      return head.ContentLength ?? 0;
    } catch (err) {
      if (notFound(err)) return null;
      throw err;
    }
  }

  private async text(relative: string): Promise<string | null> {
    try {
      const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key(relative) }));
      return (await res.Body?.transformToString("utf-8")) ?? null;
    } catch (err) {
      if (notFound(err)) return null;
      throw err;
    }
  }

  private async remove(relative: string) {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(relative) }));
  }

  /** Keys under a folder, relative to it */
  private async list(folder: string): Promise<string[]> {
    const base = `${this.key(folder)}/`;
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const res = await this.s3.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: base, ContinuationToken: token }));
      for (const entry of res.Contents ?? []) if (entry.Key) keys.push(entry.Key.slice(base.length));
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return keys;
  }

  async writeObject(hash: string, content: string): Promise<void> {
    // Content-addressed: the same name holds the same bytes
    if ((await this.size(`objects/${hash}.json`)) !== null) return;
    await this.put(`objects/${hash}.json`, content, "application/json", IMMUTABLE);
  }

  async writeMedia(hash: string, ext: string, content: Buffer): Promise<void> {
    const extension = ext.startsWith(".") ? ext : `.${ext}`;
    if ((await this.size(`media/${hash}${extension}`)) !== null) return;
    await this.put(`media/${hash}${extension}`, content, MEDIA_TYPES[extension.toLowerCase()] ?? "application/octet-stream", IMMUTABLE);
  }

  async writeRelease(releaseId: string, manifest: ReleaseManifest): Promise<void> {
    await this.put(`releases/${safe(releaseId)}.json`, JSON.stringify(manifest, null, 2), "application/json", IMMUTABLE);
  }

  async writeChannelManifest(channel: string, manifest: ChannelManifest): Promise<void> {
    await this.put(`channels/${safe(channel)}/manifest.json`, JSON.stringify(manifest, null, 2), "application/json", NO_CACHE);
  }

  async listChannels(): Promise<string[]> {
    return (await this.list("channels")).filter((k) => k.endsWith("/manifest.json")).map((k) => k.slice(0, -"/manifest.json".length));
  }

  async readChannelManifest(channel: string): Promise<ChannelManifest | null> {
    const text = await this.text(`channels/${safe(channel)}/manifest.json`);
    return text === null ? null : JSON.parse(text);
  }

  async readRelease(releaseId: string): Promise<ReleaseManifest | null> {
    const text = await this.text(`releases/${safe(releaseId)}.json`);
    return text === null ? null : JSON.parse(text);
  }

  async listReleases(): Promise<string[]> {
    return (await this.list("releases")).filter((k) => k.endsWith(".json")).map((k) => k.slice(0, -5));
  }

  async deleteRelease(releaseId: string): Promise<void> {
    await this.remove(`releases/${safe(releaseId)}.json`);
  }

  async readObject(hash: string): Promise<string | null> {
    return this.text(`objects/${hash}.json`);
  }

  async listObjects(): Promise<string[]> {
    return (await this.list("objects")).filter((k) => k.endsWith(".json")).map((k) => k.slice(0, -5));
  }

  async deleteObject(hash: string): Promise<void> {
    await this.remove(`objects/${hash}.json`);
  }

  async objectSize(hash: string): Promise<number | null> {
    return this.size(`objects/${hash}.json`);
  }

  async listMedia(): Promise<string[]> {
    return this.list("media");
  }

  async deleteMedia(filename: string): Promise<void> {
    await this.remove(`media/${filename}`);
  }

  async mediaSize(filename: string): Promise<number | null> {
    return this.size(`media/${filename}`);
  }
}
