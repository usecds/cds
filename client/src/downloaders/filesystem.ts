import fs from "fs/promises";
import path from "path";
import { ChannelManifest, ReleaseManifest, RemoteDownloader } from "../types.js";
import { safe } from "./safe.js";

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

  async fetchMedia(hash: string, ext: string): Promise<Uint8Array> {
    return fs.readFile(path.join(this.baseDir, "media", `${hash}${ext}`));
  }
}
