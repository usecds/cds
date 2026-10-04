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
import {
  analyzeTranslations,
  inferSourceLocale,
  toTranslationSummary,
  DEFAULT_SOURCE_LOCALE,
  SourceLocaleOrigin,
  TranslationReport
} from "./translations.js";
import { resolveTargets, TargetDefinition } from "./targets.js";
import { buildContentReport, ContentReport } from "./content-report.js";
import { collectMediaUsage, mediaLocales, MEDIA_COLLECTION, validateMediaMetadata } from "./media-metadata.js";
import { validateJsonLd } from "./jsonld.js";

export interface PublisherConfig {
  retentionCount?: number; // How many releases to keep (default: 3)
}

export interface PublishOptions {
  sourceLocale?: string; // original-content language; detected from the source if omitted
  targets?: TargetDefinition[]; // default + named targets (see loadTargets); built-in defaults if none
}

// Per-publish outputs meant for the pipeline (reports, source maps), never written to the store
export interface PublishArtifacts {
  sourceMap?: SourceMap & { releaseId: string };
  translations: TranslationReport;
  content: ContentReport;
  targets: Record<string, TargetDefinition>; // effective (merged) definitions, e.g. for the image project
}

/**
 * Thrown when content fails a target requirement. Nothing has been written to the store.
 * The artifacts (including the content report) are attached for the pipeline.
 */
export class PublishRequirementsError extends Error {
  constructor(public artifacts: PublishArtifacts) {
    const failed = artifacts.content.issues.filter((i) => i.severity === "requirement");
    super(
      `Publish failed: ${failed.length} unmet target requirement(s)\n` +
        failed.slice(0, 20).map((i) => `  [${i.target}] ${i.collection ? i.collection + (i.id ? "/" + i.id : "") + ": " : ""}${i.message}`).join("\n")
    );
    this.name = "PublishRequirementsError";
  }
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
  async publish(channel: string, releaseId: string, options: PublishOptions = {}): Promise<PublishResult> {
    const sourceCollections = await this.source.getCollections();
    const sourceMedia = await this.source.getMedia();
    const sourceMap = this.source.getSourceMap ? await this.source.getSourceMap() : undefined;

    // Only media referenced by content is published; the rest (and its _media entries) is ignored
    const usage = collectMediaUsage(sourceCollections);
    const rawMedia = sourceMedia.filter((m) => usage.has(m.virtualPath));
    const warnings = mediaWarnings(sourceCollections, sourceMedia, usage);
    const published = new Set(rawMedia.map((m) => m.virtualPath));
    const rawCollections = { ...sourceCollections };
    if (rawCollections[MEDIA_COLLECTION]) {
      rawCollections[MEDIA_COLLECTION] = rawCollections[MEDIA_COLLECTION].filter((m) => published.has(m.id));
    }
    const itemLocales = (collection: string, item: CollectionItem) =>
      collection === MEDIA_COLLECTION ? mediaLocales(usage, item.id) : undefined;

    const collectionsMeta: Record<string, CollectionMeta> = {};
    const mediaMeta: Record<string, MediaMeta> = {};
    const objects: { hash: string; serialized: string }[] = [];

    // 1. Normalize, validate and hash collections (nothing is written before all checks pass)
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
      objects.push({ hash, serialized });

      // Update release manifest metadata
      collectionsMeta[colName] = {
        hash,
        itemCount: items.length,
        size: Buffer.byteLength(serialized, "utf-8")
      };
    }

    // 2. Hash media
    const mediaHashes = rawMedia.map((item) => sha256(item.content));
    rawMedia.forEach((item, i) => {
      mediaMeta[item.virtualPath] = {
        hash: mediaHashes[i],
        size: item.content.length,
        mimeType: item.mimeType
      };
    });

    // Media metadata must describe media that is actually in the release
    if (rawCollections[MEDIA_COLLECTION]) {
      validateMediaMetadata(rawCollections[MEDIA_COLLECTION], mediaMeta);
    }

    // JSON-LD definitions must be valid and refer to existing collections and definitions
    validateJsonLd(rawCollections);

    // 3. Measure translation completeness against the source locale and the channel's current release
    const { locale: sourceLocale, origin } = await this.resolveSourceLocale(options.sourceLocale, rawCollections);
    const previousCollections = await this.readChannelCollections(channel);
    const translations = analyzeTranslations(rawCollections, sourceLocale, origin, previousCollections, itemLocales);

    // 4. Check targets; an unmet requirement fails the build before anything is written
    const resolved = resolveTargets(options.targets ?? []);
    const content = buildContentReport(rawCollections, translations, resolved, {
      sourceMap,
      itemLocales,
      mediaPaths: rawMedia.map((m) => m.virtualPath)
    });
    content.warnings.push(...warnings);
    const artifacts: PublishArtifacts = { translations, content, targets: resolved.effective };
    if (sourceMap) {
      artifacts.sourceMap = { releaseId, ...sourceMap };
    }
    if (content.issues.some((i) => i.severity === "requirement")) {
      throw new PublishRequirementsError(artifacts);
    }

    // 5. Write objects and media to CAS
    for (const { hash, serialized } of objects) {
      await this.store.writeObject(hash, serialized);
    }
    for (const [i, item] of rawMedia.entries()) {
      await this.store.writeMedia(mediaHashes[i], path.extname(item.virtualPath), item.content);
    }

    // 6. Construct and write the Release Manifest
    const releaseManifest: ReleaseManifest = {
      schemaVersion: 1,
      releaseId,
      createdAt: new Date().toISOString(),
      collections: collectionsMeta,
      media: mediaMeta,
      translations: toTranslationSummary(translations),
      targets: Object.keys(content.targets).sort()
    };

    validateReleaseManifest(releaseManifest);
    await this.store.writeRelease(releaseId, releaseManifest);

    // 7. Update the Channel Manifest (LAST atomic step)
    const channelManifest: ChannelManifest = {
      schemaVersion: 1,
      channel,
      releaseId,
      updatedAt: releaseManifest.createdAt
    };

    validateChannelManifest(channelManifest);
    await this.store.writeChannelManifest(channel, channelManifest);

    // 8. Clean up old releases if they exceed retention limit
    await this.manageReleaseRetention();

    return { manifest: releaseManifest, artifacts };
  }

  /**
   * Source locale precedence: publish argument → ContentSource → inferred from markers → "en".
   */
  private async resolveSourceLocale(
    argument: string | undefined,
    collections: Record<string, CollectionItem[]>
  ): Promise<{ locale: string; origin: SourceLocaleOrigin }> {
    if (argument) return { locale: argument, origin: "argument" };
    const fromSource = this.source.getSourceLocale ? await this.source.getSourceLocale() : undefined;
    if (fromSource) return { locale: fromSource, origin: "source" };
    const inferred = inferSourceLocale(collections);
    if (inferred) return { locale: inferred, origin: "inferred" };
    return { locale: DEFAULT_SOURCE_LOCALE, origin: "fallback" };
  }

  /**
   * Reads the collections of the release a channel currently points to, or undefined
   * if the channel, its release or any of its objects are missing.
   */
  private async readChannelCollections(channel: string): Promise<Record<string, CollectionItem[]> | undefined> {
    const channelManifest = await this.store.readChannelManifest(channel);
    if (!channelManifest) return undefined;
    const release = await this.store.readRelease(channelManifest.releaseId);
    if (!release) return undefined;

    const collections: Record<string, CollectionItem[]> = {};
    for (const [name, meta] of Object.entries(release.collections)) {
      const content = await this.store.readObject(meta.hash);
      if (content === null) return undefined;
      collections[name] = (JSON.parse(content) as Collection).items;
    }
    return collections;
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

// Reports media the publisher leaves out, and references to media the source doesn't provide
function mediaWarnings(
  collections: Record<string, CollectionItem[]>,
  media: { virtualPath: string }[],
  usage: Map<string, unknown>
): string[] {
  const warnings: string[] = [];
  const provided = new Set(media.map((m) => m.virtualPath));
  for (const path of provided) {
    if (!usage.has(path)) warnings.push(`Media ${path} is not referenced by any item and was not published`);
  }
  for (const item of collections[MEDIA_COLLECTION] ?? []) {
    if (!provided.has(item.id) || !usage.has(item.id)) {
      warnings.push(`_media entry ${item.id} was ignored because the media isn't published`);
    }
  }
  for (const path of usage.keys()) {
    if (!provided.has(path)) warnings.push(`Media ${path} is referenced but not provided by the source`);
  }
  return warnings;
}
