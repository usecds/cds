import { 
  ClientStorage, 
  RemoteDownloader, 
  ReleaseManifest, 
  Collection, 
  CollectionItem,
  MediaInfo,
  MenuEntry,
  ProvenanceStatus,
  ResolvedLink,
  ResolvedBlock,
  ResolvedPage,
  ResolvedRoute,
  RouteInfo,
  TranslationSummary
} from "../types.js";
import { sha256 } from "../utils.js";
import { EditOverlay } from "./overlay.js";
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
  private overlay: EditOverlay | null = null;
  private overlaid = new Map<string, { revision: number; items: CollectionItem[] }>();

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
    this.overlaid.clear();
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
   * Lays unpublished edits over the active release (previews only); null removes them. Every
   * read (collections, items, pages, menus) then sees the edited values. Releases are not changed.
   */
  setOverlay(overlay: EditOverlay | null): void {
    this.overlay = overlay;
    this.overlaid.clear();
  }

  /** A collection exactly as the active release has it, without overlay edits */
  getPublishedCollection(name: string): CollectionItem[] {
    return this.collectionsCache.get(name) || [];
  }

  // A collection as reads see it: the release's items, with the overlay's edits applied
  private items(name: string): CollectionItem[] | undefined {
    const items = this.collectionsCache.get(name);
    if (!items || !this.overlay) return items;
    const cached = this.overlaid.get(name);
    if (cached && cached.revision === this.overlay.revision) return cached.items;
    const view = this.overlay.apply(name, items);
    this.overlaid.set(name, { revision: this.overlay.revision, items: view });
    return view;
  }

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
    return this.items(name) || [];
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
    const item = this.items("_media")?.find((i) => i.id === virtualPath);
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
    const definitions = (this.items(JSONLD_COLLECTION) ?? []) as JsonLdDefinition[];
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

  // --- SITE STRUCTURE (_routes, _pages, _blocks; all optional) ---

  /**
   * All routes with their paths per locale. Empty if the release has no _routes.
   */
  getRoutes(): RouteInfo[] {
    return (this.items("_routes") ?? []).map((r) => ({
      id: r.id,
      key: r.key,
      paths: Object.fromEntries(
        Object.entries(r.translations)
          .filter(([, t]) => typeof t?.path === "string")
          .map(([locale, t]) => [locale, t.path as string])
      ),
      ...(r.page ? { page: r.page } : {}),
      ...(r.redirect ? { redirect: { route: r.redirect, status: (r.status ?? 301) as 301 | 302 } } : {})
    }));
  }

  /**
   * Paths of a route per locale, e.g. for hreflang links and a language switcher.
   */
  getAlternates(routeId: string): Record<string, string> {
    return this.getRoutes().find((r) => r.id === routeId)?.paths ?? {};
  }

  /**
   * The route, locale and page for a path (exact match), with redirects followed to their
   * final target. Null if no route has this path.
   */
  async resolveRoute(path: string): Promise<ResolvedRoute | null> {
    const routes = this.getRoutes();
    for (const route of routes) {
      const locale = Object.keys(route.paths).find((l) => route.paths[l] === path);
      if (!locale) continue;

      if (route.redirect) {
        let target = route;
        while (target.redirect) target = routes.find((r) => r.id === target.redirect!.route)!;
        const targetPath = target.paths[locale] ?? Object.values(target.paths)[0];
        return { route, locale, redirect: { path: targetPath, status: route.redirect.status } };
      }
      const page = route.page ? await this.getPage(route.page, locale) : null;
      return { route, locale, ...(page ? { page } : {}) };
    }
    return null;
  }

  /**
   * A page in one locale with its blocks in order, each with its items resolved.
   */
  async getPage(pageId: string, locale: string): Promise<ResolvedPage | null> {
    const page = await this.getItemById("_pages", pageId);
    if (!page) return null;
    const texts = page.translations[locale] ?? {};

    const blocks: ResolvedBlock[] = [];
    for (const blockId of (page.blocks as string[] | undefined) ?? []) {
      const block = await this.getItemById("_blocks", blockId);
      if (!block) continue;
      const { media: localizedMedia, ...blockTexts } = block.translations[locale] ?? {};

      let items: { collection: string; item: CollectionItem }[] = [];
      if (block.source?.collection) {
        const collection = block.source.collection as string;
        items = (await this.getCollection(collection)).map((item) => ({ collection, item }));
      } else {
        for (const ref of (block.items ?? []) as { collection: string; id: string }[]) {
          const item = await this.getItemById(ref.collection, ref.id);
          if (item) items.push({ collection: ref.collection, item });
        }
      }

      blocks.push({
        id: block.id,
        key: block.key,
        type: block.type,
        texts: blockTexts,
        items,
        media: [...(block.media ?? []), ...(Array.isArray(localizedMedia) ? localizedMedia : [])],
        links: (block.links as string[] | undefined) ?? [],
        settings: (block.settings as Record<string, unknown> | undefined) ?? {}
      });
    }

    return {
      id: page.id,
      key: page.key,
      ...(typeof texts.title === "string" ? { title: texts.title } : {}),
      ...(typeof texts.description === "string" ? { description: texts.description } : {}),
      texts,
      blocks
    };
  }

  // --- MENUS AND LINKS (_menu; optional) ---

  /**
   * A menu (a _menu item no other item lists as a child, found by key) as a tree for one locale.
   * Entries without a label in that locale, or whose route has no path there, are left out
   * together with their children.
   */
  getMenu(key: string, locale: string): MenuEntry[] | null {
    const items = this.items("_menu") ?? [];
    const children = new Set(items.flatMap((i) => (i.children as string[] | undefined) ?? []));
    const root = items.find((i) => i.key === key && !children.has(i.id));
    if (!root) return null;

    const build = (ids: string[]): MenuEntry[] =>
      ids.flatMap((id) => {
        const link = this.resolveLink(id, locale);
        if (!link) return [];
        const item = items.find((i) => i.id === id)!;
        return [{ ...link, children: build((item.children as string[] | undefined) ?? []) }];
      });
    return build((root.children as string[] | undefined) ?? []);
  }

  /**
   * A _menu item's label and href in one locale (also used for block links). Null if it has no
   * label in that locale, or its route has no path there.
   */
  resolveLink(id: string, locale: string): ResolvedLink | null {
    const item = (this.items("_menu") ?? []).find((i) => i.id === id);
    const label = item?.translations[locale]?.label;
    if (!item || typeof label !== "string" || !label) return null;

    const link = item.link as { route?: string; block?: string; url?: string } | undefined;
    if (link?.url) return { id, key: item.key, label, href: link.url, external: true };
    if (link?.route) {
      const path = this.getAlternates(link.route)[locale];
      if (!path) return null;
      const block = link.block ? (this.items("_blocks") ?? []).find((b) => b.id === link.block) : undefined;
      return { id, key: item.key, label, href: block ? `${path}#${block.key}` : path, external: false };
    }
    return { id, key: item.key, label, external: false };
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
