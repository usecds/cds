import { ChannelManifest, ReleaseManifest, RemoteDownloader } from "../types.js";
import { safe } from "./safe.js";

/**
 * Downloads a published CDS store over HTTP(S), e.g. from a CDN. The channel manifest is
 * requested with If-None-Match, so an unchanged channel costs a 304. `fetchImpl` replaces the
 * global fetch, e.g. one that signs each request (S3Downloader in @usecds/s3).
 */
export class HttpDownloader implements RemoteDownloader {
  private etag?: string;
  private lastManifest?: ChannelManifest;

  constructor(
    private readonly baseUrl: string,
    private readonly init: RequestInit = {},
    private readonly fetchImpl: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init)
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private async get(relative: string, headers: Record<string, string> = {}): Promise<Response> {
    const res = await this.fetchImpl(`${this.baseUrl}/${relative}`, {
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

  async fetchMedia(hash: string, ext: string): Promise<Uint8Array> {
    return new Uint8Array(await (await this.get(`media/${hash}${ext}`)).arrayBuffer());
  }
}
