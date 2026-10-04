import type { CollectionItem, ContentSource, SourceFieldRef, SourceItemRef, SourceMap, SourceMedia } from "@cds/server";

type Row = Record<string, any>;

export interface DirectusCollectionConfig {
  /** Directus fields to fetch: the union of what the frontend requests (default "*") */
  fields?: string;
  /** Primary key field (default "id", or "code" when rows have no id, as in languages) */
  primaryKey?: string;
  /** Field used as the CDS key (default: slug, else the primary key) */
  key?: string;
  /** Fields copied into translations[defaultLocale], so CDS can report on them */
  localized?: string[];
}

export interface DirectusSourceConfig {
  url: string;
  /** Read-only token; the source only sends GET requests */
  token?: string;
  /** Language of the top-level content fields */
  defaultLocale: string;
  collections: Record<string, DirectusCollectionConfig>;
  /** Collections that may not exist or may be forbidden for the token: skipped with a warning */
  optional?: string[];
  /** Base URL for source map links (default: url) */
  adminUrl?: string;
  /**
   * Maps the records to the CDS contract (e.g. pages, blocks and menus to _routes, _pages, _blocks
   * and _menu). Without one, each record is published as it is, under `directus`.
   */
  map?: DirectusMapping;
  /** Media path of a file in mapped publishing (default directus/<id><ext>) */
  mediaPath?: (file: FileMeta) => string;
  log?: (message: string) => void;
}

/** What a mapping gets besides the records */
export interface DirectusMapContext {
  /** The source locale: top-level Directus fields are in it */
  locale: string;
  /** Publishes a file and returns its media path (null for an empty or unreadable reference) */
  media(fileId: string | null | undefined): string | null;
  /** A file's Directus metadata, without publishing it */
  file(fileId: string | null | undefined): FileMeta | null;
  /** The source field of a value, for $sources */
  source(collection: string, id: string | number, field: string, options?: Pick<SourceFieldRef, "format" | "editable">): SourceFieldRef;
  log(message: string): void;
}

/** An item as a mapping returns it: a CDS item, plus where it comes from (not published) */
export type MappedItem = CollectionItem & {
  /** The record behind the item, for admin links in the source map */
  $origin?: { collection: string; id: string | number };
  /** The source field of each value, keyed by field path in the item ("translations.en.title") */
  $sources?: Record<string, SourceFieldRef>;
};

/** Turns the fetched records (keyed by collection) into CDS collections */
export type DirectusMapping = (
  records: Record<string, Row[]>,
  ctx: DirectusMapContext
) => Record<string, MappedItem[]> | Promise<Record<string, MappedItem[]>>;

interface Loaded {
  collections: Record<string, CollectionItem[]>;
  files: Map<string, FileMeta>;
  virtualPaths: Map<string, string>;
  origins?: Record<string, Record<string, SourceItemRef>>;
}

export interface FileMeta {
  id: string;
  filename_download?: string | null;
  title?: string | null;
  description?: string | null;
  type?: string | null;
  width?: number | null;
  height?: number | null;
  focal_point_x?: number | null;
  focal_point_y?: number | null;
  [field: string]: unknown;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/avif": ".avif", "image/gif": ".gif",
  "image/svg+xml": ".svg", "image/x-icon": ".ico", "image/vnd.microsoft.icon": ".ico", "application/pdf": ".pdf",
  "video/mp4": ".mp4", "font/woff2": ".woff2", "font/woff": ".woff"
};

const defaultMediaPath = (f: FileMeta) =>
  `directus/${f.id}${(f.filename_download?.match(/\.[a-z0-9]+$/i)?.[0] ?? EXTENSIONS[f.type ?? ""] ?? "").toLowerCase()}`;

const slug = (text: string) =>
  text.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/**
 * Reads a Directus instance (GET only) and provides its content as CDS collections:
 *
 * - every configured collection, fetched with its field set (relations expanded as configured);
 *   each record becomes an item with id, key, translations and media, and the untouched
 *   Directus record under `directus` (so a Directus-compatible reader can serve it unchanged)
 * - every file the records reference (by ID, or as /assets/<id> inside text) as CDS media,
 *   with a `_media` item carrying title (alt), description, size and focal point
 * - a source map with links to the records and files in the Directus admin
 */
export class DirectusSource implements ContentSource {
  private loaded?: Promise<Loaded>;
  private readonly log: (message: string) => void;

  constructor(private readonly config: DirectusSourceConfig) {
    this.log = config.log ?? (() => undefined);
  }

  private async get(path: string): Promise<{ status: number; body: any }> {
    const res = await fetch(`${this.config.url.replace(/\/$/, "")}${path}`, {
      method: "GET",
      headers: this.config.token ? { Authorization: `Bearer ${this.config.token}` } : {}
    });
    const body = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
    return { status: res.status, body };
  }

  private async getAsset(id: string): Promise<Buffer> {
    const res = await fetch(`${this.config.url.replace(/\/$/, "")}/assets/${encodeURIComponent(id)}`, {
      method: "GET",
      headers: this.config.token ? { Authorization: `Bearer ${this.config.token}` } : {}
    });
    if (!res.ok) throw new Error(`GET /assets/${id}: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  private load() {
    this.loaded ??= (async () => {
      // 1. Records
      const records: Record<string, Row[]> = {};
      for (const [collection, cfg] of Object.entries(this.config.collections)) {
        const fields = encodeURIComponent(cfg.fields ?? "*");
        const { status, body } = await this.get(`/items/${collection}?fields=${fields}&limit=-1`);
        if (status !== 200) {
          const message = `${collection}: ${status} ${body?.errors?.[0]?.message ?? ""}`.trim();
          if (this.config.optional?.includes(collection)) {
            this.log(`skipped optional collection ${message}`);
            continue;
          }
          throw new Error(`Directus collection ${message}`);
        }
        records[collection] = Array.isArray(body.data) ? body.data : body.data ? [body.data] : [];
        this.log(`${collection}: ${records[collection].length} records`);
        // A relation expanded without its key can't be filtered on or collapsed back to it
        const keyless = new Set<string>();
        for (const row of records[collection]) {
          for (const [field, value] of Object.entries(row)) {
            const related = Array.isArray(value) ? value : [value];
            if (related.some((r) => r && typeof r === "object" && !("id" in r) && !("code" in r) && !("item" in r))) keyless.add(field);
          }
        }
        for (const field of keyless) {
          this.log(`warning: ${collection}.${field} is expanded without its primary key; add ${field}.id to its fields`);
        }
      }

      // 2. Files referenced by any record (by ID, or as /assets/<id> inside text)
      const files = new Map<string, FileMeta>();
      const list = await this.get(`/files?limit=-1&fields=*`);
      const known = new Map<string, FileMeta>(
        list.status === 200 ? (list.body.data as FileMeta[]).map((f) => [f.id, f]) : []
      );
      const referencedIn = (value: unknown, found: Set<string>) => {
        if (typeof value === "string") {
          for (const match of value.match(UUID) ?? []) found.add(match.toLowerCase());
        } else if (Array.isArray(value)) value.forEach((v) => referencedIn(v, found));
        else if (value && typeof value === "object") Object.values(value).forEach((v) => referencedIn(v, found));
      };
      const fileIdsOf = new Map<Row, string[]>();
      for (const rows of Object.values(records)) {
        for (const row of rows) {
          const candidates = new Set<string>();
          referencedIn(row, candidates);
          const ids: string[] = [];
          for (const id of candidates) {
            let meta = known.get(id);
            if (!meta && list.status !== 200 && !files.has(id)) {
              // Without the file list, ask for each candidate; most UUIDs are record IDs and 403/404
              const one = await this.get(`/files/${id}?fields=*`);
              if (one.status === 200) meta = one.body.data;
            }
            if (meta) {
              files.set(id, meta);
              ids.push(id);
            }
          }
          fileIdsOf.set(row, ids.sort());
        }
      }
      const virtualPaths = new Map<string, string>([...files.values()].map((f) => [f.id, defaultMediaPath(f)]));
      this.log(`files: ${files.size} referenced`);

      if (this.config.map) return this.mapRecords(records, files);

      // 3. CDS items
      const collections: Record<string, CollectionItem[]> = {};
      for (const [collection, rows] of Object.entries(records)) {
        const cfg = this.config.collections[collection];
        collections[collection] = rows.map((row) => {
          const pkField = cfg.primaryKey ?? ("id" in row ? "id" : "code");
          const pk = String(row[pkField]);
          const keyValue = row[cfg.key ?? "slug"];
          const translations: Record<string, Record<string, unknown>> = {
            [this.config.defaultLocale]: Object.fromEntries((cfg.localized ?? []).map((f) => [f, row[f] ?? null]))
          };
          // Directus translation rows (translations: [{ languages_code, ...fields }])
          for (const t of Array.isArray(row.translations) ? row.translations : []) {
            if (!t || typeof t !== "object" || !t.languages_code) continue;
            const code = typeof t.languages_code === "object" ? t.languages_code.code : t.languages_code;
            const fields = Object.fromEntries(Object.entries(t).filter(([k]) => k !== "id" && k !== "languages_code" && !k.endsWith("_id")));
            translations[code] = { ...(translations[code] ?? {}), ...fields };
          }
          return {
            id: pk,
            key: typeof keyValue === "string" && keyValue ? keyValue : pk,
            translations,
            media: (fileIdsOf.get(row) ?? []).map((id) => virtualPaths.get(id)!),
            directus: row
          };
        });
      }

      // 4. Media metadata
      collections._media = [...files.values()].map((f) => ({ ...this.mediaItem(f, virtualPaths.get(f.id)!), directus: f }));

      return { collections, files, virtualPaths };
    })();
    return this.loaded;
  }

  /**
   * Mapped publishing: the mapping turns Directus records into the CDS contract. Only the files it
   * asks for (ctx.media) are published; each item's media list is derived from the paths it holds.
   * Items may carry $origin (the record behind the item, for admin links) and $sources (the source
   * field of each value, for editing); both go into the source map and are not published.
   */
  private async mapRecords(records: Record<string, Row[]>, available: Map<string, FileMeta>): Promise<Loaded> {
    const files = new Map<string, FileMeta>();
    const virtualPaths = new Map<string, string>();
    const pathOf = (f: FileMeta) => this.config.mediaPath?.(f) ?? defaultMediaPath(f);
    const ctx: DirectusMapContext = {
      locale: this.config.defaultLocale,
      media: (id) => {
        if (id === null || id === undefined || id === "") return null;
        const file = available.get(String(id).toLowerCase());
        if (!file) {
          this.log(`warning: file ${id} is referenced by the mapping but not readable`);
          return null;
        }
        files.set(file.id, file);
        const path = pathOf(file);
        virtualPaths.set(file.id, path);
        return path;
      },
      file: (id) => (id ? available.get(String(id).toLowerCase()) ?? null : null),
      source: (collection, id, field, options = {}) => ({ collection, id: String(id), field, ...options }),
      log: this.log
    };
    const mapped = await this.config.map!(records, ctx);

    const mediaPaths = new Set(virtualPaths.values());
    const mediaIn = (value: unknown, found: Set<string>) => {
      if (typeof value === "string") {
        if (mediaPaths.has(value)) found.add(value);
      } else if (Array.isArray(value)) value.forEach((v) => mediaIn(v, found));
      else if (value && typeof value === "object") Object.values(value).forEach((v) => mediaIn(v, found));
    };
    const collections: Record<string, CollectionItem[]> = {};
    const origins: Record<string, Record<string, SourceItemRef>> = {};
    for (const [collection, items] of Object.entries(mapped)) {
      origins[collection] = {};
      collections[collection] = items.map((mappedItem) => {
        const { $origin, $sources, ...item } = mappedItem as MappedItem;
        const found = new Set<string>(item.media ?? []);
        mediaIn(item, found);
        origins[collection][item.id] = {
          id: $origin ? String($origin.id) : item.id,
          ...($origin ? { path: `/admin/content/${$origin.collection}/${encodeURIComponent(String($origin.id))}` } : {}),
          ...($sources && Object.keys($sources).length ? { fields: $sources } : {})
        };
        // Every CDS item has translations; an item without texts has none
        return { ...item, translations: item.translations ?? {}, ...(found.size ? { media: [...found].sort() } : {}) } as CollectionItem;
      });
    }

    collections._media = [...files.values()].map((f) => ({
      ...this.mediaItem(f, virtualPaths.get(f.id)!),
      ...(f.filename_download ? { filename: f.filename_download } : {})
    }));
    this.log(`mapped: ${Object.keys(mapped).length} collections, ${files.size} files`);
    return { collections, files, virtualPaths, origins };
  }

  private mediaItem(f: FileMeta, path: string): CollectionItem {
    const focal = typeof f.focal_point_x === "number" && typeof f.focal_point_y === "number" && f.width && f.height
      ? { x: Math.min(1, Math.max(0, f.focal_point_x / f.width)), y: Math.min(1, Math.max(0, f.focal_point_y / f.height)) }
      : undefined;
    const name = f.filename_download ? slug(f.filename_download.replace(/\.[^.]+$/, "")) : "";
    return {
      id: path,
      key: path,
      ...(name ? { name } : {}),
      translations: { [this.config.defaultLocale]: { alt: f.title ?? null, description: f.description ?? null } },
      ...(f.width ? { width: f.width } : {}),
      ...(f.height ? { height: f.height } : {}),
      ...(focal ? { focalPoint: focal } : {})
    };
  }

  async getCollections(): Promise<Record<string, CollectionItem[]>> {
    return (await this.load()).collections;
  }

  async getMedia(): Promise<SourceMedia[]> {
    const { files, virtualPaths } = await this.load();
    const media: SourceMedia[] = [];
    for (const file of files.values()) {
      media.push({
        virtualPath: virtualPaths.get(file.id)!,
        content: await this.getAsset(file.id),
        mimeType: file.type ?? "application/octet-stream"
      });
    }
    return media;
  }

  async getSourceLocale(): Promise<string> {
    return this.config.defaultLocale;
  }

  async getSourceMap(): Promise<SourceMap> {
    const { collections, files, virtualPaths, origins } = await this.load();
    const map: SourceMap = {
      sources: { directus: { baseUrl: this.config.adminUrl ?? this.config.url } },
      collections: {},
      media: {}
    };
    for (const [collection, items] of Object.entries(collections)) {
      if (collection === "_media") continue;
      map.collections[collection] = origins
        ? { items: origins[collection] ?? {} } // mapped: items don't correspond to one Directus collection
        : {
            source: { adapter: "directus", collection },
            items: Object.fromEntries(items.map((i) => [i.id, { id: i.id, path: `/admin/content/${collection}/${encodeURIComponent(i.id)}` }]))
          };
    }
    for (const file of files.values()) {
      map.media[virtualPaths.get(file.id)!] = { adapter: "directus", id: file.id, path: `/admin/files/${file.id}` };
    }
    return map;
  }
}
