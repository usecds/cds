import type { ContentField, ContentType } from "@cds/server";
import type { DirectusCollectionConfig, DirectusMapContext, MappedItem } from "./source.js";

type Row = Record<string, any>;

const TEXT = new Set(["text", "richText"]);

const idOf = (value: unknown): string | null =>
  value === null || value === undefined ? null : typeof value === "object" ? idOf((value as Row).id) : String(value);

/** Content types that are only reached as another type's children (one-to-many) */
function childTypes(types: ContentType[]): Set<string> {
  const children = new Set<string>();
  for (const type of types) {
    for (const field of type.fields) if (field.kind === "references" && field.via && field.related) children.add(field.related);
  }
  return children;
}

/**
 * What the publish has to fetch for these content types: each top-level type with its children
 * expanded (a one-to-many's rows come nested in their parent). Merge it into DirectusSourceConfig.collections.
 */
export function contentTypeCollections(types: ContentType[]): Record<string, DirectusCollectionConfig> {
  const children = childTypes(types);
  const config: Record<string, DirectusCollectionConfig> = {};
  for (const type of types) {
    if (children.has(type.collection)) continue;
    const nested = type.fields.filter((f) => f.kind === "references" && f.via).map((f) => `${f.field}.*`);
    config[type.collection] = { fields: ["*", ...nested].join(",") };
  }
  return config;
}

/**
 * Maps Directus records to declared content types (see ContentType in @cds/server): texts into
 * translations[locale] with their source fields (editable in a preview), values onto the item
 * (with their source fields too, for a preview's field editor), files to media, references to ids,
 * and one-to-many children into their own collection, referenced by id in their order. Every
 * declared type becomes a collection, empty when there are no records.
 */
export function mapContentTypes(types: ContentType[], records: Record<string, Row[]>, ctx: DirectusMapContext): Record<string, MappedItem[]> {
  const byName = new Map(types.map((t) => [t.collection, t]));
  const rows = new Map<string, Map<string, Row>>(types.map((t) => [t.collection, new Map()]));
  const collect = (type: ContentType, row: Row) => {
    const id = idOf(row);
    if (id && !rows.get(type.collection)!.has(id)) rows.get(type.collection)!.set(id, row);
  };
  for (const type of types) for (const row of records[type.collection] ?? []) collect(type, row);

  // Children arrive nested in their parents
  const sortField = (type: ContentType | undefined) => type?.fields.find((f) => f.kind === "sort")?.field;
  const childIds = (field: ContentField, value: unknown): string[] => {
    const related = field.related ? byName.get(field.related) : undefined;
    const list = Array.isArray(value) ? value : [];
    const objects = list.filter((v) => v && typeof v === "object") as Row[];
    if (related) objects.forEach((child) => collect(related, child));
    const sort = sortField(related);
    const ordered = sort
      ? [...list].sort((a, b) => (Number((a as Row)?.[sort] ?? Infinity) || Infinity) - (Number((b as Row)?.[sort] ?? Infinity) || Infinity))
      : list;
    return ordered.map(idOf).filter((id): id is string => Boolean(id));
  };
  // Parents first, so children are collected before their own collection is mapped
  const order = [...types].sort((a, b) => Number(childTypes(types).has(a.collection)) - Number(childTypes(types).has(b.collection)));

  const out: Record<string, MappedItem[]> = {};
  for (const type of order) {
    out[type.collection] = [...rows.get(type.collection)!.values()].map((row) => {
      const id = idOf(row)!;
      const texts: Record<string, unknown> = {};
      const sources: NonNullable<MappedItem["$sources"]> = {};
      const item: MappedItem = { id, key: id, translations: {} };
      for (const field of type.fields) {
        const value = row[field.field];
        if (TEXT.has(field.kind)) {
          texts[field.field] = value ?? null;
          sources[`translations.${ctx.locale}.${field.field}`] = ctx.source(type.collection, id, field.field, field.kind === "richText" ? { format: "html" } : {});
          continue;
        }
        switch (field.kind) {
          case "file":
            item[field.field] = ctx.media(idOf(value));
            break;
          case "reference":
            item[field.field] = idOf(value);
            break;
          case "references":
            item[field.field] = childIds(field, value);
            break;
          default:
            item[field.field] = value ?? null;
            if (field.kind === "slug" && typeof value === "string" && value) item.key = value;
            sources[field.field] = ctx.source(type.collection, id, field.field);
        }
      }
      item.translations = { [ctx.locale]: texts };
      return { ...item, $origin: { collection: type.collection, id: row.id }, $sources: sources };
    });
  }
  return out;
}

// The content type contract, for sites that use this mapper without depending on @cds/server directly
export { contentTypeTarget } from "@cds/server";
export type { ContentField, ContentFieldKind, ContentType } from "@cds/server";
