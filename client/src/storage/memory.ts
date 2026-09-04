import { ClientStorage, ReleaseManifest, ChannelManifest } from "../types.js";

export class MemoryStorage implements ClientStorage {
  private objects = new Map<string, string>();
  private media = new Map<string, Buffer>();
  private releases = new Map<string, ReleaseManifest>();
  private channels = new Map<string, ChannelManifest>();
  private activeReleaseId: string | null = null;

  async saveObject(hash: string, content: string): Promise<void> {
    this.objects.set(hash, content);
  }

  async readObject(hash: string): Promise<string | null> {
    return this.objects.get(hash) || null;
  }

  async hasObject(hash: string): Promise<boolean> {
    return this.objects.has(hash);
  }

  async saveMedia(hash: string, content: Buffer): Promise<void> {
    this.media.set(hash, content);
  }

  async readMedia(hash: string): Promise<Buffer | null> {
    return this.media.get(hash) || null;
  }

  async hasMedia(hash: string): Promise<boolean> {
    return this.media.has(hash);
  }

  async saveRelease(releaseId: string, manifest: ReleaseManifest): Promise<void> {
    this.releases.set(releaseId, manifest);
  }

  async readRelease(releaseId: string): Promise<ReleaseManifest | null> {
    return this.releases.get(releaseId) || null;
  }

  async listReleases(): Promise<string[]> {
    return Array.from(this.releases.keys()).sort();
  }

  async deleteRelease(releaseId: string): Promise<void> {
    this.releases.delete(releaseId);
  }

  async getActiveReleaseId(): Promise<string | null> {
    return this.activeReleaseId;
  }

  async setActiveReleaseId(releaseId: string | null): Promise<void> {
    this.activeReleaseId = releaseId;
  }

  async saveChannelManifest(channel: string, manifest: ChannelManifest): Promise<void> {
    this.channels.set(channel, manifest);
  }

  async readChannelManifest(channel: string): Promise<ChannelManifest | null> {
    return this.channels.get(channel) || null;
  }
}
