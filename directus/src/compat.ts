import { DirectusQuery, applyDeepSorts, project, parseFields, runQuery, Row } from "./query.js";

export type { DirectusQuery } from "./query.js";

// What the compat layer needs from a CDS client (structurally, so this module has no dependencies)
export interface CdsReader {
  getCollection(name: string): Promise<Array<{ id: string; [field: string]: any }>>;
  getMediaContent(virtualPath: string): Promise<Buffer | null>;
}

/** An error shaped like a failed Directus response */
export class DirectusCompatError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
    this.name = "DirectusCompatError";
  }
  get errors() {
    return [{ message: this.message, extensions: { code: this.statusCode === 403 ? "FORBIDDEN" : "NOT_FOUND" } }];
  }
}

/**
 * Applies Directus asset transformation parameters (width, height, fit, format, quality,
 * withoutEnlargement), e.g. with an image library. Without one, assets are served as originals.
 */
export type AssetTransform = (
  original: { data: Buffer; type: string },
  params: Record<string, string>
) => Promise<{ data: Buffer; type: string }>;

const TRANSFORM_PARAMS = ["width", "height", "fit", "format", "quality", "withoutEnlargement", "transforms", "key"];

const forbidden = (what: string) =>
  new DirectusCompatError(403, `You don't have permission to access ${what} or it does not exist.`);

/**
 * Directus REST semantics (read-only) answered from a synced CDS release that DirectusSource
 * published: records come back exactly as Directus returned them at publish time, with filters,
 * sort, limit (default 100) and field projection applied per request; files and assets come from
 * the release's media. Frontends keep their Directus queries and mappers; only the transport changes.
 */
export function createDirectusCompat(reader: CdsReader, options: { transform?: AssetTransform } = {}) {
  const records = async (collection: string): Promise<Row[]> => {
    if (collection.startsWith("_")) throw forbidden(`collection "${collection}"`);
    const items = await reader.getCollection(collection);
    if (!items.length) throw forbidden(`collection "${collection}"`);
    return items.map((item) => item.directus).filter(Boolean);
  };

  const filesById = async (): Promise<Map<string, { meta: Row; path: string }>> => {
    const media = await reader.getCollection("_media");
    return new Map(media.filter((m) => m.directus?.id).map((m) => [String(m.directus.id), { meta: m.directus, path: m.id }]));
  };

  const primaryKeyOf = (row: Row) => ("id" in row ? row.id : row.code);

  const api = {
    /** GET /items/<collection> */
    async items(collection: string, query: DirectusQuery = {}): Promise<Row[]> {
      return runQuery(await records(collection), query);
    },

    /** GET /items/<collection>/<id> */
    async item(collection: string, id: string | number, query: DirectusQuery = {}): Promise<Row> {
      const row = (await records(collection)).find((r) => String(primaryKeyOf(r)) === String(id));
      if (!row) throw forbidden(`item "${id}" in collection "${collection}"`);
      return project(applyDeepSorts(row, query), parseFields(query.fields as string | string[] | undefined)) as Row;
    },

    /** GET /files */
    async files(query: DirectusQuery = {}): Promise<Row[]> {
      return runQuery([...(await filesById()).values()].map((f) => f.meta), query);
    },

    /** GET /files/<id> */
    async file(id: string, query: DirectusQuery = {}): Promise<Row> {
      const file = (await filesById()).get(id);
      if (!file) throw forbidden(`file "${id}"`);
      return project(file.meta, parseFields(query.fields as string | string[] | undefined)) as Row;
    },

    /**
     * GET /assets/<id>: the original file, or a transformed one when transformation parameters
     * are given and a transform is configured
     */
    async asset(id: string, params: Record<string, unknown> = {}): Promise<{ data: Buffer; type: string; filename: string }> {
      const file = (await filesById()).get(id);
      const data = file ? await reader.getMediaContent(file.path) : null;
      if (!file || !data) throw forbidden(`asset "${id}"`);
      const original = { data, type: String(file.meta.type ?? "application/octet-stream") };
      const transformParams = Object.fromEntries(
        Object.entries(params).filter(([k, v]) => TRANSFORM_PARAMS.includes(k) && v !== undefined && v !== null).map(([k, v]) => [k, String(v)])
      );
      const result = options.transform && Object.keys(transformParams).length
        ? await options.transform(original, transformParams)
        : original;
      return { ...result, filename: String(file.meta.filename_download ?? id) };
    },

    /**
     * A Directus REST path with query params, e.g. request("/items/menu_items", { "filter[status][_eq]": "published" }).
     * Returns { data } like Directus; throws DirectusCompatError for unknown collections, items or files.
     */
    async request(urlPath: string, params: Record<string, unknown> = {}): Promise<{ data: any }> {
      const url = new URL(urlPath, "http://cds.local");
      const query: DirectusQuery = { ...Object.fromEntries(url.searchParams), ...params };
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      if (parts[0] === "items" && parts.length === 2) return { data: await api.items(parts[1], query) };
      if (parts[0] === "items" && parts.length === 3) return { data: await api.item(parts[1], parts[2], query) };
      if (parts[0] === "files" && parts.length === 1) return { data: await api.files(query) };
      if (parts[0] === "files" && parts.length === 2) return { data: await api.file(parts[1], query) };
      if (parts[0] === "server" && (parts[1] === "ping" || parts[1] === "health")) return { data: { status: "ok" } };
      throw new DirectusCompatError(404, `Route ${url.pathname} isn't served from CDS`);
    }
  };
  return api;
}

export type DirectusCompat = ReturnType<typeof createDirectusCompat>;
