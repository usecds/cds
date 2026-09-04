import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { ObjectStore, ReleaseManifest, ChannelManifest } from "../types.js";

export class FilesystemStore implements ObjectStore {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = path.resolve(baseDir);
  }

  private async ensureDir(dirPath: string): Promise<void> {
    await fs.mkdir(dirPath, { recursive: true });
  }

  async writeObject(hash: string, content: string): Promise<void> {
    const filePath = path.join(this.baseDir, "objects", `${hash}.json`);
    await this.ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, content, "utf-8");
  }

  async writeMedia(hash: string, ext: string, content: Buffer): Promise<void> {
    const extension = ext.startsWith(".") ? ext : `.${ext}`;
    const filePath = path.join(this.baseDir, "media", `${hash}${extension}`);
    await this.ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, content);
  }

  async writeRelease(releaseId: string, manifest: ReleaseManifest): Promise<void> {
    // Escape filename just in case, though releaseId should be alphanumeric/dashes
    const safeReleaseId = releaseId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filePath = path.join(this.baseDir, "releases", `${safeReleaseId}.json`);
    await this.ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, JSON.stringify(manifest, null, 2), "utf-8");
  }

  async writeChannelManifest(channel: string, manifest: ChannelManifest): Promise<void> {
    const safeChannel = channel.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filePath = path.join(this.baseDir, "channels", safeChannel, "manifest.json");
    await this.ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, JSON.stringify(manifest, null, 2), "utf-8");
  }

  async readRelease(releaseId: string): Promise<ReleaseManifest | null> {
    const safeReleaseId = releaseId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filePath = path.join(this.baseDir, "releases", `${safeReleaseId}.json`);
    if (!existsSync(filePath)) {
      return null;
    }
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content);
  }

  async listReleases(): Promise<string[]> {
    const dir = path.join(this.baseDir, "releases");
    if (!existsSync(dir)) return [];
    const files = await fs.readdir(dir);
    return files
      .filter((f: string) => f.endsWith(".json"))
      .map((f: string) => f.slice(0, -5)); // Remove .json extension
  }

  async deleteRelease(releaseId: string): Promise<void> {
    const safeReleaseId = releaseId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filePath = path.join(this.baseDir, "releases", `${safeReleaseId}.json`);
    if (existsSync(filePath)) {
      await fs.unlink(filePath);
    }
  }

  async listObjects(): Promise<string[]> {
    const dir = path.join(this.baseDir, "objects");
    if (!existsSync(dir)) return [];
    const files = await fs.readdir(dir);
    return files
      .filter((f: string) => f.endsWith(".json"))
      .map((f: string) => f.slice(0, -5)); // Return list of hashes
  }

  async deleteObject(hash: string): Promise<void> {
    const filePath = path.join(this.baseDir, "objects", `${hash}.json`);
    if (existsSync(filePath)) {
      await fs.unlink(filePath);
    }
  }

  async listMedia(): Promise<string[]> {
    const dir = path.join(this.baseDir, "media");
    if (!existsSync(dir)) return [];
    return await fs.readdir(dir);
  }

  async deleteMedia(filename: string): Promise<void> {
    const filePath = path.join(this.baseDir, "media", filename);
    if (existsSync(filePath)) {
      await fs.unlink(filePath);
    }
  }
}
