import { 
  ClientStorage, 
  RemoteDownloader, 
  ReleaseManifest, 
  Collection, 
  CollectionItem,
  MediaInfo,
  ProvenanceStatus,
  TranslationSummary
} from "../types.js";
import { sha256 } from "../utils.js";
import { JSONLD_COLLECTION, JsonLdDefinition, mergeJsonLd, readFieldPath, setJsonLdProperty } from "./jsonld.js";
import { 
  validateChannelManifest, 
  validateReleaseManifest, 
  validateCollection 
} from "../validation.js";

export interface CDSClientConfig {
  storage: ClientStorage;
  downloader: RemoteDownloader;
  retentionCount?: number; // default: 3
  target?: string; // only activate releases that satisfy this target
}

export interface SyncResult {
  success: boolean;
  updated: boolean;
  releaseId?: string;
  error?: Error;
}

export class CDSClient {
  private storage: ClientStorage;
  private downloader: RemoteDownloader;
  private retentionCount: number;
  private target?: string;
  private activeRelease: ReleaseManifest | null = null;
  
  // In-memory cache for fast, sub-millisecond lookups
  private collectionsCache = new Map<string, CollectionItem[]>();

  constructor(config: CDSClientConfig) {
    this.storage = config.storage;
    this.downloader = config.downloader;
    this.retentionCount = config.retentionCount ?? 3;
    this.target = config.target;
  }

  /**
   * Initializes the client by loading the last active local release from storage.
   */
  async initialize(): Promise<void> {
    const activeId = await this.storage.getActiveReleaseId();
    if (activeId) {
      try {
        const manifest = await this.storage.readRelease(activeId);
        if (manifest) {
          validateReleaseManifest(manifest);
          this.activeRelease = manifest;
          await this.loadActiveCollectionsIntoCache();
        }
      } catch (err) {
        console.error("Failed to initialize active release, falling back to clean state:", err);
        this.activeRelease = null;
      }
    }
  }

  /**
   * Returns the currently active release manifest, or null if none is active.
   */
  getActiveRelease(): ReleaseManifest | null {
    return this.activeRelease;
  }

  /**
   * Loads all collections from the active release into the memory cache.
   */
  private async loadActiveCollectionsIntoCache(): Promise<void> {
    this.collectionsCache.clear();
    if (!this.activeRelease) return;

    for (const [colName, colMeta] of Object.entries(this.activeRelease.collections)) {
      const serialized = await this.storage.readObject(colMeta.hash);
      if (serialized) {
        try {
          const col: Collection = JSON.parse(serialized);
          validateCollection(col);
          this.collectionsCache.set(colName, col.items);
        } catch (err) {
          console.error(`Failed to load cached collection ${colName}:`, err);
        }
      }
    }
  }

  /**
   * Syncs with the remote server/CDN channel.
   * If a new release is available, downloads, validates, and atomically activates it.
   */
  async sync(channel: string): Promise<SyncResult> {
    try {
      // 1. Fetch channel manifest (optionally passing current active releaseId as ETag)
      const currentEtag = this.activeRelease?.releaseId;
      const { manifest: channelManifest, notModified } = await this.downloader.fetchChannelManifest(channel, currentEtag);

      if (notModified) {
        return { success: true, updated: false, releaseId: this.activeRelease?.releaseId };
      }

      validateChannelManifest(channelManifest);

      // Check schema version compatibility
      if (channelManifest.schemaVersion !== 1) {
        throw new Error(`Incompatible schema version: ${channelManifest.schemaVersion}. Client supports version 1.`);
      }

      // If already on this release, we're done
      if (this.activeRelease && this.activeRelease.releaseId === channelManifest.releaseId) {
        // Just write local channel manifest to be safe
        await this.storage.saveChannelManifest(channel, channelManifest);
        return { success: true, updated: false, releaseId: this.activeRelease.releaseId };
      }

      // 2. Fetch target Release Manifest
      const targetReleaseId = channelManifest.releaseId;
      const releaseManifest = await this.downloader.fetchReleaseManifest(targetReleaseId);
      validateReleaseManifest(releaseManifest);

      // Refuse releases not built and checked for this client's target
      if (this.target && !(releaseManifest.targets ?? []).includes(this.target)) {
        throw new Error(`Release ${targetReleaseId} does not satisfy target ${this.target}`);
      }

      // 3. Download, hash-verify, and stage all missing objects & media
      const stagedObjects = new Map<string, string>();
      const stagedMedia = new Map<string, Buffer>();

      // Staging JSON collections
      for (const [colName, colMeta] of Object.entries(releaseManifest.collections)) {
        const hashExists = await this.storage.hasObject(colMeta.hash);
        if (!hashExists) {
          const content = await this.downloader.fetchObject(colMeta.hash);
          
          // Verify SHA-256 hash
          const computedHash = sha256(content);
          if (computedHash !== colMeta.hash) {
            throw new Error(`Hash mismatch for collection ${colName}. Expected ${colMeta.hash}, got ${computedHash}`);
          }

          // Schema validation on client
          const colObj: Collection = JSON.parse(content);
          validateCollection(colObj);

          stagedObjects.set(colMeta.hash, content);
        }
      }

      // Staging Media assets
      for (const [virtualPath, mediaMeta] of Object.entries(releaseManifest.media)) {
        const hashExists = await this.storage.hasMedia(mediaMeta.hash);
        if (!hashExists) {
          const ext = virtualPath.includes(".") ? virtualPath.substring(virtualPath.lastIndexOf(".")) : "";
          const content = await this.downloader.fetchMedia(mediaMeta.hash, ext);

          // Verify SHA-256 hash
          const computedHash = sha256(content);
          if (computedHash !== mediaMeta.hash) {
            throw new Error(`Hash mismatch for media ${virtualPath}. Expected ${mediaMeta.hash}, got ${computedHash}`);
          }

          stagedMedia.set(mediaMeta.hash, content);
        }
      }

      // 4. Atomic Commit (Write staged files to permanent cache, activate)
      for (const [hash, content] of stagedObjects.entries()) {
        await this.storage.saveObject(hash, content);
      }
      for (const [hash, content] of stagedMedia.entries()) {
        await this.storage.saveMedia(hash, content);
      }

      // Save the release manifest itself
      await this.storage.saveRelease(targetReleaseId, releaseManifest);

      // Update Channel Manifest locally
      await this.storage.saveChannelManifest(channel, channelManifest);

      // Switch pointer atomically
      await this.storage.setActiveReleaseId(targetReleaseId);
      this.activeRelease = releaseManifest;

      // Warm cache
      await this.loadActiveCollectionsIntoCache();

      // 5. Prune local old releases
      await this.pruneOldLocalReleases();

      return { success: true, updated: true, releaseId: targetReleaseId };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      // Return unsuccessful sync, but continue working using the existing active release
      return { success: false, updated: false, error };
    }
  }

  /**
   * Prunes client-side release manifests that exceed the local retention quota.
   */
  private async pruneOldLocalReleases(): Promise<void> {
    const list = await this.storage.listReleases();
    list.sort(); // Lexicographical sort

    if (list.length > this.retentionCount) {
      const toDelete = list.slice(0, list.length - this.retentionCount);
      for (const relId of toDelete) {
        // Ensure we never delete the active release!
        if (this.activeRelease && relId === this.activeRelease.releaseId) {
          continue;
        }
        await this.storage.deleteRelease(relId);
      }
    }
  }

  // --- QUERY & CONTENT ACCESS API ---

  /**
   * Returns list of collection names in the active release.
   */
  getCollectionsList(): string[] {
    if (!this.activeRelease) return [];
    return Object.keys(this.activeRelease.collections);
  }

  /**
   * Exposes a complete collection by name.
   */
  async getCollection(name: string): Promise<CollectionItem[]> {
    return this.collectionsCache.get(name) || [];
  }

  /**
   * Finds a single item by its stable key.
   */
  async getItemByKey(collectionName: string, key: string): Promise<CollectionItem | null> {
    const col = await this.getCollection(collectionName);
    return col.find((item) => item.key === key) || null;
  }

  /**
   * Finds a single item by its unique ID.
   */
  async getItemById(collectionName: string, id: string): Promise<CollectionItem | null> {
    const col = await this.getCollection(collectionName);
    return col.find((item) => item.id === id) || null;
  }

  /**
   * Dynamic discovery of all available locales across the active release.
   */
  getLocales(): string[] {
    const localesSet = new Set<string>();
    for (const items of this.collectionsCache.values()) {
      for (const item of items) {
        if (item.translations) {
          for (const locale of Object.keys(item.translations)) {
            localesSet.add(locale);
          }
        }
      }
    }
    return Array.from(localesSet).sort();
  }

  /**
   * Translation completeness summary of the active release, or null if it has none.
   */
  getTranslationSummary(): TranslationSummary | null {
    return this.activeRelease?.translations ?? null;
  }

  /**
   * Provenance of one translated field. Staleness is detected via the marker's sourceHash only;
   * the publisher's previous-release fallback appears in the build report, not here.
   */
  getTranslationStatus(
    item: CollectionItem,
    locale: string,
    field: string
  ): { status: ProvenanceStatus | null; stale: boolean } {
    const marker = item._provenance?.translations?.[locale]?.[field];
    if (!marker) return { status: null, stale: false };

    let stale = false;
    if (marker.sourceHash) {
      const fromLocale = marker.from ?? this.activeRelease?.translations?.sourceLocale;
      const reference = fromLocale ? item.translations[fromLocale]?.[field] : undefined;
      stale = typeof reference === "string" && sha256(reference) !== marker.sourceHash;
    }
    return { status: marker.status, stale };
  }

  /**
   * Resolves the references in a collection item to their actual collection item objects.
   */
  async resolveReferences(item: CollectionItem): Promise<CollectionItem[]> {
    if (!item.references || !Array.isArray(item.references)) {
      return [];
    }

    const resolved: CollectionItem[] = [];
    for (const ref of item.references) {
      const targetItem = await this.getItemById(ref.collection, ref.id);
      if (targetItem) {
        resolved.push(targetItem);
      }
    }
    return resolved;
  }

  /**
   * Media file details plus its _media metadata (alt text and description in the given locale).
   * Returns null if the path isn't in the active release. Texts are absent if not set for that locale.
   */
  getMediaInfo(virtualPath: string, locale?: string): MediaInfo | null {
    const meta = this.activeRelease?.media[virtualPath];
    if (!meta) return null;

    const info: MediaInfo = { path: virtualPath, hash: meta.hash, size: meta.size, mimeType: meta.mimeType };
    const item = this.collectionsCache.get("_media")?.find((i) => i.id === virtualPath);
    if (!item) return info;

    if (typeof item.name === "string" && item.name) info.name = item.name;
    if (typeof item.width === "number") info.width = item.width;
    if (typeof item.height === "number") info.height = item.height;
    if (item.focalPoint) info.focalPoint = item.focalPoint;
    if (item.focalPoints) info.focalPoints = item.focalPoints;
    const texts = locale ? item.translations[locale] : undefined;
    if (typeof texts?.alt === "string" && texts.alt) info.alt = texts.alt;
    if (typeof texts?.description === "string" && texts.description) info.description = texts.description;
    return info;
  }

  /**
   * schema.org JSON-LD data for an item, from its own _jsonld reference or its collection's default
   * (appliesTo). Contains no URLs: the site generator adds url/@id and replaces each image's
   * "_media" (virtual path) with its URL. Referenced items (ref:) are resolved one level deep.
   * Returns null if no definition applies.
   */
  async getJsonLd(collection: string, item: CollectionItem, locale: string): Promise<Record<string, any> | null> {
    const data = await this.buildJsonLd(collection, item, locale, 1);
    return data ? { "@context": "https://schema.org", ...data } : null;
  }

  private async buildJsonLd(
    collection: string,
    item: CollectionItem,
    locale: string,
    depth: number
  ): Promise<Record<string, any> | null> {
    const definitions = (this.collectionsCache.get(JSONLD_COLLECTION) ?? []) as JsonLdDefinition[];
    const own = item.references?.find((r) => r.collection === JSONLD_COLLECTION);
    const def = own ? definitions.find((d) => d.id === own.id) : definitions.find((d) => d.appliesTo === collection);
    if (!def) return null;

    // Fixed values, then localized fixed values, then mapped values
    const data: Record<string, any> = { "@type": def.type };
    mergeJsonLd(data, def.values ?? {});
    mergeJsonLd(data, def.translations?.[locale] ?? {});

    for (const [property, path] of Object.entries(def.map ?? {})) {
      let value: unknown;
      const media = path.match(/^media\[(\d+)\]$/);
      const ref = path.match(/^ref:(.+)$/);
      if (media) {
        const virtualPath = item.media?.[Number(media[1])];
        const info = virtualPath ? this.getMediaInfo(virtualPath, locale) : null;
        if (info) {
          value = Object.fromEntries(Object.entries({
            "@type": "ImageObject",
            _media: info.path,
            caption: info.alt,
            description: info.description,
            width: info.width,
            height: info.height
          }).filter(([, v]) => v !== undefined));
        }
      } else if (ref) {
        if (depth > 0) {
          const target = (await this.resolveReferences(item)).find((r) =>
            item.references?.some((x) => x.collection === ref[1] && x.id === r.id));
          if (target) value = (await this.buildJsonLd(ref[1], target, locale, depth - 1)) ?? undefined;
        }
      } else {
        value = readFieldPath(item, locale, path);
      }
      if (value !== undefined && value !== null && value !== "") setJsonLdProperty(data, property, value);
    }
    return data;
  }

  /**
   * Utility to retrieve raw binary media content from local cache.
   */
  async getMediaContent(virtualPath: string): Promise<Buffer | null> {
    if (!this.activeRelease) return null;
    const meta = this.activeRelease.media[virtualPath];
    if (!meta) return null;
    return await this.storage.readMedia(meta.hash);
  }
}
