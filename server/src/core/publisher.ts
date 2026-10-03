import path from "path";
import { 
  ContentSource, 
  ObjectStore, 
  Collection, 
  CollectionItem, 
  ReleaseManifest, 
  ChannelManifest, 
  CollectionMeta, 
  MediaMeta 
} from "../types.js";
import { deterministicStringify, sha256 } from "../utils.js";
import { 
  validateCollection, 
  validateReleaseManifest, 
  validateChannelManifest 
} from "../validation.js";

export interface PublisherConfig {
  retentionCount?: number; // How many releases to keep (default: 3)
}

// Per-publish outputs meant for the pipeline (reports, source maps), never written to the store
export interface PublishArtifacts {}

export interface PublishResult {
  manifest: ReleaseManifest;
  artifacts: PublishArtifacts;
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

    return { manifest: releaseManifest, artifacts: {} };
  }

  /**
   * Cleans up old releases that exceed the configured retention limit.
   */
  private async manageReleaseRetention(): Promise<void> {
    const limit = this.config.retentionCount ?? 3;
    const releases = await this.store.listReleases();

    // Sort releases lexicographically (or by timestamp if ids are formatted as ISO timestamps)
    // To be safe, we sort them so latest are at the end, and we delete from the beginning (oldest).
    releases.sort();

    if (releases.length > limit) {
      const toDelete = releases.slice(0, releases.length - limit);
      for (const relId of toDelete) {
        await this.store.deleteRelease(relId);
      }
    }
  }

  /**
   * Scans all objects/media in storage and garbage-collects any files
   * not referenced by any of the currently retained releases.
   */
  async garbageCollect(): Promise<{ deletedObjects: number; deletedMedia: number }> {
    const activeReleases = await this.store.listReleases();
    
    const referencedObjects = new Set<string>();
    const referencedMediaHashes = new Set<string>();

    // 1. Gather all referenced hashes from all active releases
    for (const relId of activeReleases) {
      const manifest = await this.store.readRelease(relId);
      if (manifest) {
        for (const col of Object.values(manifest.collections)) {
          referencedObjects.add(col.hash);
        }
        for (const med of Object.values(manifest.media)) {
          referencedMediaHashes.add(med.hash);
        }
      }
    }

    // 2. Scan and GC Objects
    let deletedObjects = 0;
    const allObjects = await this.store.listObjects();
    for (const objHash of allObjects) {
      if (!referencedObjects.has(objHash)) {
        await this.store.deleteObject(objHash);
        deletedObjects++;
      }
    }

    // 3. Scan and GC Media
    let deletedMedia = 0;
    const allMediaFiles = await this.store.listMedia();
    for (const filename of allMediaFiles) {
      // Filename is <hash>.<ext>
      const hash = filename.split(".")[0];
      if (!referencedMediaHashes.has(hash)) {
        await this.store.deleteMedia(filename);
        deletedMedia++;
      }
    }

    return { deletedObjects, deletedMedia };
  }
}
