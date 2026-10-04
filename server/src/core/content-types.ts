import type { TargetDefinition } from "./targets.js";

/**
 * A content type: a collection a consumer (e.g. a template) declares it needs, independent of the
 * CMS. Source adapters map the CMS's records to it; the declaration also yields the publish checks
 * (contentTypeTarget), so content that doesn't fit fails the build or shows up in the report.
 *
 * Field kinds and where their values go in a CDS item:
 *   text, richText     translations[locale][field]   (text the content is written in; richText is HTML)
 *   string, number, boolean, date, select, status, sort, slug
 *                      item[field]                    (values; slug also becomes the item's key)
 *   file               item[field] = media path
 *   reference          item[field] = id of an item in `related`
 *   references         item[field] = ids of items in `related`, in order (a one-to-many's children)
 */
export type ContentFieldKind =
  | "text"
  | "richText"
  | "string"
  | "number"
  | "boolean"
  | "date"
  | "select"
  | "status"
  | "sort"
  | "slug"
  | "file"
  | "reference"
  | "references";

export interface ContentField {
  field: string;
  kind: ContentFieldKind;
  required?: boolean;
  /** Allowed values of a select */
  options?: string[];
  /** The content type a reference points to */
  related?: string;
  /** For references: the field on the related items that points back (one-to-many) */
  via?: string;
  label?: string;
}

export interface ContentType {
  collection: string;
  fields: ContentField[];
  /** Where the declaration comes from, for messages (e.g. "template hotelplatform, bundle integrations") */
  declaredBy?: string;
}

export const TEXT_KINDS: ReadonlySet<ContentFieldKind> = new Set(["text", "richText"]);

/**
 * The publish checks a set of content types implies, as a target: each declared collection's
 * required fields (texts in the source locale, values on the item) and select values. A collection
 * without items passes: declaring a type doesn't require content for it.
 */
export function contentTypeTarget(types: ContentType[], id = "content-types"): TargetDefinition {
  const collections: NonNullable<TargetDefinition["collections"]> = {};
  for (const type of types) {
    const required = (kinds: (k: ContentFieldKind) => boolean) =>
      type.fields.filter((f) => f.required && kinds(f.kind)).map((f) => f.field);
    const localized = required((k) => TEXT_KINDS.has(k));
    const fields = required((k) => !TEXT_KINDS.has(k));
    const enums = Object.fromEntries(
      type.fields
        .filter((f) => f.kind === "select" && f.options?.length)
        .map((f) => [f.field, { enum: [...f.options!, null] }])
    );
    if (!localized.length && !fields.length && !Object.keys(enums).length) continue;
    collections[type.collection] = {
      ...(localized.length ? { localized: { type: "object", required: localized } } : {}),
      ...(fields.length || Object.keys(enums).length
        ? { fields: { type: "object", ...(fields.length ? { required: fields } : {}), ...(Object.keys(enums).length ? { properties: enums } : {}) } }
        : {})
    };
  }
  return { id, scope: Object.keys(collections), collections };
}
