import path from "path";
import { 
  ContentSource, 
  ObjectStore, 
  Collection, 
  CollectionItem, 
  ReleaseManifest, 
  ChannelManifest, 
  CollectionMeta, 
  MediaMeta,
  SourceMap
} from "../types.js";
import { deterministicStringify, sha256 } from "../utils.js";
import { 
  validateCollection, 
  validateReleaseManifest, 
  validateChannelManifest 
} from "../validation.js";
import { analyzeStorage, StorageReport } from "./storage-report.js";

export interface PublisherConfig {
  retentionCount?: number; // How many releases to keep (default: 3)
}

// Per-publish outputs meant for the pipeline (reports, source maps), never written to the store
export interface PublishArtifacts {
  sourceMap?: SourceMap & { releaseId: string };
}

export interface PublishResult {
  manifest: ReleaseManifest;
  artifacts: PublishArtifacts;
}

export interface GarbageCollectOptions {
  dryRun?: boolean; // report what would be deleted without deleting anything
}

export interface GarbageCollectResult {
  dryRun: boolean;
  deletedObjects: number; // in a dry run: objects that would be deleted
  deletedMedia: number; // in a dry run: media files that would be deleted
  freedBytes: number;
  report: StorageReport; // state before deletion
}

export class Publisher {
  private source: ContentSource;
  private store: ObjectStore;
  private config: PublisherConfig;

  constructor(source: ContentSource, store: ObjectStore, config: PublisherConfig = {}) {
    this.source = source;
    this.store = store;
    this.config = {
      retentionCount: 3,
      ...config
    };
  }

  /**
   * Compiles the source content and publishes a new release to the object store.
   * Updates the channel manifest as the final atomic action.
   */
  async publish(channel: string, releaseId: string): Promise<PublishResult> {
    const rawCollections = await this.source.getCollections();
    const rawMedia = await this.source.getMedia();
    const sourceMap = this.source.getSourceMap ? await this.source.getSourceMap() : undefined;

    const collectionsMeta: Record<string, CollectionMeta> = {};
    const mediaMeta: Record<string, MediaMeta> = {};

    // 1. Process and normalize collections
    for (const [colName, items] of Object.entries(rawCollections)) {
      const normalizedCollection: Collection = {
        schemaVersion: 1,
        collection: colName,
        items: items
      };

      // Validate collection against JSON Schema
      validateCollection(normalizedCollection);

      // Serialize deterministically and compute SHA-256 hash
      const serialized = deterministicStringify(normalizedCollection);
      const hash = sha256(serialized);

      // Write object to CAS
      await this.store.writeObject(hash, serialized);

      // Update release manifest metadata
      collectionsMeta[colName] = {
        hash,
        itemCount: items.length,
        size: Buffer.byteLength(serialized, "utf-8")
      };
    }

    // 2. Process and write media
    for (const item of rawMedia) {
      const hash = sha256(item.content);
      const ext = path.extname(item.virtualPath);

      // Write media to CAS
      await this.store.writeMedia(hash, ext, item.content);

      // Update release manifest metadata
      mediaMeta[item.virtualPath] = {
        hash,
        size: item.content.length,
        mimeType: item.mimeType
      };
    }

    // 3. Construct and write the Release Manifest
    const releaseManifest: ReleaseManifest = {
      schemaVersion: 1,
      releaseId,
      createdAt: new Date().toISOString(),
      collections: collectionsMeta,
      media: mediaMeta
    };

    validateReleaseManifest(releaseManifest);
    await this.store.writeRelease(releaseId, releaseManifest);

    // 4. Update the Channel Manifest (LAST atomic step)
    const channelManifest: ChannelManifest = {
      schemaVersion: 1,
      channel,
      releaseId,
      updatedAt: releaseManifest.createdAt
    };

    validateChannelManifest(channelManifest);
    await this.store.writeChannelManifest(channel, channelManifest);

    // 5. Clean up old releases if they exceed retention limit
    await this.manageReleaseRetention();

    const artifacts: PublishArtifacts = {};
    if (sourceMap) {
      artifacts.sourceMap = { releaseId, ...sourceMap };
    }

    return { manifest: releaseManifest, artifacts };
  }

  /**
   * Cleans up old releases that exceed the configured retention limit.
   * Releases that a channel currently points to are never deleted.
   */
  private async manageReleaseRetention(): Promise<void> {
    const limit = this.config.retentionCount ?? 3;
    const releases = await this.store.listReleases();

    // Sort releases lexicographically (or by timestamp if ids are formatted as ISO timestamps)
    // To be safe, we sort them so latest are at the end, and we delete from the beginning (oldest).
    releases.sort();

    if (releases.length > limit) {
      const pinned = new Set<string>();
      for (const channel of await this.store.listChannels()) {
        const manifest = await this.store.readChannelManifest(channel);
        if (manifest) pinned.add(manifest.releaseId);
      }

      const toDelete = releases.slice(0, releases.length - limit);
      for (const relId of toDelete) {
        if (pinned.has(relId)) continue;
        await this.store.deleteRelease(relId);
      }
    }
  }

  /**
   * Reports per-release storage usage, diffs between releases, channel pointers
   * and orphaned files. Read-only.
   */
  async analyzeStorage(): Promise<StorageReport> {
    return analyzeStorage(this.store);
  }

  /**
   * Deletes all objects/media not referenced by any retained release.
   * Deletes exactly the orphans listed in the returned report.
   */
  async garbageCollect(options: GarbageCollectOptions = {}): Promise<GarbageCollectResult> {
    const dryRun = options.dryRun ?? false;
    const report = await analyzeStorage(this.store);

    let deletedObjects = 0;
    let deletedMedia = 0;
    for (const orphan of report.orphans.files) {
      if (orphan.kind === "object") {
        if (!dryRun) await this.store.deleteObject(orphan.hash);
        deletedObjects++;
      } else {
        if (!dryRun) await this.store.deleteMedia(orphan.file.slice("media/".length));
        deletedMedia++;
      }
    }

    return { dryRun, deletedObjects, deletedMedia, freedBytes: report.orphans.bytes, report };
  }
}
