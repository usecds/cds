import fs from "fs/promises";
import path from "path";
import { ChannelManifest, ReleaseManifest, RemoteDownloader } from "./types.js";

// Stores map characters outside [a-zA-Z0-9_-] in release IDs and channel names to "_"
const safe = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_");

/**
 * Downloads a published CDS store over HTTP(S), e.g. from a CDN. The channel manifest is
 * requested with If-None-Match, so an unchanged channel costs a 304.
 */
export class HttpDownloader implements RemoteDownloader {
  private etag?: string;
  private lastManifest?: ChannelManifest;

  constructor(private readonly baseUrl: string, private readonly init: RequestInit = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private async get(relative: string, headers: Record<string, string> = {}): Promise<Response> {
    const res = await fetch(`${this.baseUrl}/${relative}`, {
      ...this.init,
      headers: { ...(this.init.headers as Record<string, string> | undefined), ...headers }
    });
    if (!res.ok && res.status !== 304) throw new Error(`GET ${relative}: ${res.status} ${res.statusText}`);
    return res;
  }

  async fetchChannelManifest(channel: string): Promise<{ manifest: ChannelManifest; etag?: string; notModified?: boolean }> {
    const res = await this.get(`channels/${safe(channel)}/manifest.json`, this.etag ? { "If-None-Match": this.etag } : {});
    if (res.status === 304 && this.lastManifest) {
      return { manifest: this.lastManifest, etag: this.etag, notModified: true };
    }
    const manifest: ChannelManifest = await res.json();
    this.etag = res.headers.get("etag") ?? undefined;
    this.lastManifest = manifest;
    return { manifest, etag: this.etag };
  }

  async fetchReleaseManifest(releaseId: string): Promise<ReleaseManifest> {
    return (await this.get(`releases/${safe(releaseId)}.json`)).json();
  }

  // The exact bytes: the client verifies them against the hash
  async fetchObject(hash: string): Promise<string> {
    return (await this.get(`objects/${hash}.json`)).text();
  }

  async fetchMedia(hash: string, ext: string): Promise<Buffer> {
    return Buffer.from(await (await this.get(`media/${hash}${ext}`)).arrayBuffer());
  }
}

/**
 * Reads a published CDS store from a local folder (the layout FilesystemStore writes).
 */
export class FilesystemDownloader implements RemoteDownloader {
  constructor(private readonly baseDir: string) {}

  async fetchChannelManifest(channel: string, currentEtag?: string): Promise<{ manifest: ChannelManifest; etag?: string; notModified?: boolean }> {
    const manifest: ChannelManifest = JSON.parse(await fs.readFile(path.join(this.baseDir, "channels", safe(channel), "manifest.json"), "utf-8"));
    // The release ID serves as the ETag for a local store
    return { manifest, etag: manifest.releaseId, notModified: currentEtag === manifest.releaseId };
  }

  async fetchReleaseManifest(releaseId: string): Promise<ReleaseManifest> {
    return JSON.parse(await fs.readFile(path.join(this.baseDir, "releases", `${safe(releaseId)}.json`), "utf-8"));
  }

  async fetchObject(hash: string): Promise<string> {
    return fs.readFile(path.join(this.baseDir, "objects", `${hash}.json`), "utf-8");
  }

  async fetchMedia(hash: string, ext: string): Promise<Buffer> {
    return fs.readFile(path.join(this.baseDir, "media", `${hash}${ext}`));
  }
}
