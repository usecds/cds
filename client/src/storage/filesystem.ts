import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { ClientStorage, ReleaseManifest, ChannelManifest } from "../types.js";

export class FilesystemStorage implements ClientStorage {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = path.resolve(baseDir);
  }

  private async ensureDir(dirPath: string): Promise<void> {
    await fs.mkdir(dirPath, { recursive: true });
  }

  async saveObject(hash: string, content: string): Promise<void> {
    const filePath = path.join(this.baseDir, "objects", `${hash}.json`);
    await this.ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, content, "utf-8");
  }

  async readObject(hash: string): Promise<string | null> {
    const filePath = path.join(this.baseDir, "objects", `${hash}.json`);
    if (!existsSync(filePath)) return null;
    return await fs.readFile(filePath, "utf-8");
  }

  async hasObject(hash: string): Promise<boolean> {
    const filePath = path.join(this.baseDir, "objects", `${hash}.json`);
    return existsSync(filePath);
  }

  async saveMedia(hash: string, content: Buffer): Promise<void> {
    const filePath = path.join(this.baseDir, "media", `${hash}.bin`);
    await this.ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, content);
  }

  async readMedia(hash: string): Promise<Buffer | null> {
    const filePath = path.join(this.baseDir, "media", `${hash}.bin`);
    if (!existsSync(filePath)) return null;
    return await fs.readFile(filePath);
  }

  async hasMedia(hash: string): Promise<boolean> {
    const filePath = path.join(this.baseDir, "media", `${hash}.bin`);
    return existsSync(filePath);
  }

  async saveRelease(releaseId: string, manifest: ReleaseManifest): Promise<void> {
    const safeId = releaseId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filePath = path.join(this.baseDir, "releases", `${safeId}.json`);
    await this.ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, JSON.stringify(manifest, null, 2), "utf-8");
  }

  async readRelease(releaseId: string): Promise<ReleaseManifest | null> {
    const safeId = releaseId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filePath = path.join(this.baseDir, "releases", `${safeId}.json`);
    if (!existsSync(filePath)) return null;
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content);
  }

  async listReleases(): Promise<string[]> {
    const dir = path.join(this.baseDir, "releases");
    if (!existsSync(dir)) return [];
    const files = await fs.readdir(dir);
    return files
      .filter((f: string) => f.endsWith(".json"))
      .map((f: string) => f.slice(0, -5))
      .sort();
  }

  async deleteRelease(releaseId: string): Promise<void> {
    const safeId = releaseId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filePath = path.join(this.baseDir, "releases", `${safeId}.json`);
    if (existsSync(filePath)) {
      await fs.unlink(filePath);
    }
  }

  async getActiveReleaseId(): Promise<string | null> {
    const filePath = path.join(this.baseDir, "active_release.txt");
    if (!existsSync(filePath)) return null;
    const content = await fs.readFile(filePath, "utf-8");
    return content.trim() || null;
  }

  async setActiveReleaseId(releaseId: string | null): Promise<void> {
    const filePath = path.join(this.baseDir, "active_release.txt");
    await this.ensureDir(path.dirname(filePath));
    if (releaseId === null) {
      if (existsSync(filePath)) {
        await fs.unlink(filePath);
      }
    } else {
      await fs.writeFile(filePath, releaseId, "utf-8");
    }
  }

  async saveChannelManifest(channel: string, manifest: ChannelManifest): Promise<void> {
    const safeChannel = channel.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filePath = path.join(this.baseDir, "channels", `${safeChannel}.json`);
    await this.ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, JSON.stringify(manifest, null, 2), "utf-8");
  }

  async readChannelManifest(channel: string): Promise<ChannelManifest | null> {
    const safeChannel = channel.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filePath = path.join(this.baseDir, "channels", `${safeChannel}.json`);
    if (!existsSync(filePath)) return null;
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content);
  }
}
