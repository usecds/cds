import { CollectionItem } from "../types.js";
import { validateJsonLdDefinition } from "../validation.js";

// Reserved collection holding schema.org JSON-LD definitions
export const JSONLD_COLLECTION = "_jsonld";

/**
 * Field paths in a definition's map:
 *   name, address.city, amenities[0]   field of the item (translations[locale] first, then the item)
 *   media[0]                           the item's first media file, as an ImageObject
 *   ref:hotels                         the item's reference into "hotels", with that collection's JSON-LD
 */
export const JSONLD_PATH = /^(?:media\[\d+\]|ref:[\w-]+|[A-Za-z_]\w*(?:\[\d+\])?(?:\.[A-Za-z_]\w*(?:\[\d+\])?)*)$/;

export interface JsonLdDefinition extends CollectionItem {
  type: string;
  appliesTo?: string;
  values?: Record<string, any>;
  map?: Record<string, string>;
}

/**
 * Checks the _jsonld collection against the content. Throws on the first problem:
 * invalid definitions or paths, ref: to unknown collections, references to unknown
 * definitions, and more than one default (appliesTo) per collection.
 */
export function validateJsonLd(collections: Record<string, CollectionItem[]>): void {
  const definitions = (collections[JSONLD_COLLECTION] ?? []) as JsonLdDefinition[];
  const ids = new Set(definitions.map((d) => d.id));
  const defaults = new Map<string, string>();

  for (const def of definitions) {
    validateJsonLdDefinition(def);
    if (def.appliesTo) {
      if (!collections[def.appliesTo]) {
        throw new Error(`Invalid _jsonld item (${def.id}): appliesTo unknown collection "${def.appliesTo}"`);
      }
      const existing = defaults.get(def.appliesTo);
      if (existing) {
        throw new Error(`Collection "${def.appliesTo}" has two JSON-LD defaults: ${existing} and ${def.id}`);
      }
      defaults.set(def.appliesTo, def.id);
    }
    for (const [property, path] of Object.entries(def.map ?? {})) {
      if (!JSONLD_PATH.test(path)) {
        throw new Error(`Invalid _jsonld item (${def.id}): "${property}" has an invalid path "${path}"`);
      }
      const ref = path.match(/^ref:(.+)$/);
      if (ref && !collections[ref[1]]) {
        throw new Error(`Invalid _jsonld item (${def.id}): "${property}" refers to unknown collection "${ref[1]}"`);
      }
    }
  }

  for (const [collection, items] of Object.entries(collections)) {
    for (const item of items) {
      for (const ref of item.references ?? []) {
        if (ref.collection === JSONLD_COLLECTION && !ids.has(ref.id)) {
          throw new Error(`Item ${collection}/${item.id} references unknown _jsonld definition "${ref.id}"`);
        }
      }
    }
  }
}

/**
 * The definition that describes an item: its own reference into _jsonld, else its collection's default.
 */
export function jsonLdDefinitionFor(
  collections: Record<string, CollectionItem[]>,
  collection: string,
  item: CollectionItem
): JsonLdDefinition | undefined {
  const definitions = (collections[JSONLD_COLLECTION] ?? []) as JsonLdDefinition[];
  const own = item.references?.find((r) => r.collection === JSONLD_COLLECTION);
  if (own) return definitions.find((d) => d.id === own.id);
  return definitions.find((d) => d.appliesTo === collection);
}

/**
 * Value of a plain field path (not media[] or ref:) for one locale; undefined if absent.
 */
export function readFieldPath(item: CollectionItem, locale: string, path: string): unknown {
  const segments = path.split(".");
  const step = (value: any, segment: string) => {
    const [, key, index] = segment.match(/^(\w+)(?:\[(\d+)\])?$/) ?? [];
    const next = value?.[key];
    return index === undefined ? next : next?.[Number(index)];
  };
  const [first, ...rest] = segments;
  const localized = step(item.translations[locale], first);
  let value = localized !== undefined ? localized : step(item, first);
  for (const segment of rest) value = step(value, segment);
  return value;
}

/**
 * Whether a mapped path yields nothing for an item and locale (used for report recommendations).
 */
export function isJsonLdPathEmpty(
  collections: Record<string, CollectionItem[]>,
  item: CollectionItem,
  locale: string,
  path: string
): boolean {
  const media = path.match(/^media\[(\d+)\]$/);
  if (media) return !item.media?.[Number(media[1])];
  const ref = path.match(/^ref:(.+)$/);
  if (ref) {
    const ids = new Set((collections[ref[1]] ?? []).map((i) => i.id));
    return !(item.references ?? []).some((r) => r.collection === ref[1] && ids.has(r.id));
  }
  const value = readFieldPath(item, locale, path);
  return value === undefined || value === null || value === "";
}
