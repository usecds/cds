import { CollectionItem } from "../types.js";

// Reserved collection holding schema.org JSON-LD definitions (same rules as @usecds/server)
export const JSONLD_COLLECTION = "_jsonld";

export interface JsonLdDefinition extends CollectionItem {
  type: string;
  appliesTo?: string;
  values?: Record<string, any>;
  map?: Record<string, string>; // schema.org property (dots for nesting) -> field path
}

/**
 * Value of a plain field path for one locale: translations[locale] first, then the item.
 */
export function readFieldPath(item: CollectionItem, locale: string, path: string): unknown {
  const step = (value: any, segment: string) => {
    const [, key, index] = segment.match(/^(\w+)(?:\[(\d+)\])?$/) ?? [];
    const next = value?.[key];
    return index === undefined ? next : next?.[Number(index)];
  };
  const [first, ...rest] = path.split(".");
  const localized = step(item.translations[locale], first);
  let value = localized !== undefined ? localized : step(item, first);
  for (const segment of rest) value = step(value, segment);
  return value;
}

// Deep-merges plain objects; later values win, arrays and scalars are replaced
export function mergeJsonLd(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
  for (const [key, value] of Object.entries(source)) {
    const current = target[key];
    if (isPlainObject(value) && isPlainObject(current)) {
      mergeJsonLd(current, value);
    } else {
      target[key] = isPlainObject(value) ? mergeJsonLd({}, value) : value;
    }
  }
  return target;
}

// "author.name" -> { author: { name: value } }, merged into target
export function setJsonLdProperty(target: Record<string, any>, property: string, value: unknown): void {
  const keys = property.split(".");
  let node = target;
  for (const key of keys.slice(0, -1)) {
    if (!isPlainObject(node[key])) node[key] = {};
    node = node[key];
  }
  node[keys[keys.length - 1]] = value;
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
