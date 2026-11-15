import type { CollectionItem, EditResult, EditValue, EditorSession, SourceEditor, SourceFieldRef, SourceMap } from "../types.js";
import type { ContentField, ContentType } from "./content-types.js";

/**
 * Adds, reorders and removes items in CDS terms, for previews: the same for every collection with a
 * content type, whatever the source system. A new item's form comes from its content type
 * (describe), values are CDS field names, positions are CDS ids; the source map says where each
 * value goes, and the adapter's editor writes it.
 *
 *   a list        a parent's `references` field (its source ref names the record and, with `via`,
 *                 the field on the children that points back), or a whole collection
 *   order         the content type's `sort` field, renumbered among the list's items
 *   remove        unpublishes (the `status` field) where the type has one; deletes otherwise
 *
 * Every write is checked against the value the snapshot shows, like any edit: a source that changed
 * meanwhile answers with a conflict.
 */

/** The content an item editor works on: the release (with a preview's edits) and its source map */
export interface ItemSnapshot {
  collections: Record<string, CollectionItem[]>;
  map: SourceMap;
  /** The language texts are written in */
  locale: string;
}

/** A parent's list: its `references` field */
export interface ItemList {
  collection: string;
  id: string;
  field: string;
}

export interface ItemEditorConfig {
  editor: SourceEditor;
  /** The current content; read again for every operation */
  snapshot: () => Promise<ItemSnapshot>;
  /** Content types beyond the source map's own (map.contentTypes) */
  contentTypes?: ContentType[];
  /**
   * Source fields every created record gets, e.g. its project: (collection) => ({ projects: [{ projects_id: id }] }).
   * Gets the editor's session (to read what the source needs) and the source collection.
   */
  createDefaults?: (collection: string, session: EditorSession, sourceCollection: string) => Record<string, unknown> | Promise<Record<string, unknown>>;
}

export interface ItemEditor {
  /** The content type of a collection: what a form for a new item shows */
  describe(collection: string): Promise<ContentType | null>;
  /** The list an item is in (its parent's field, or its whole collection) and the ids in it, in order */
  listOf(collection: string, id: string): Promise<{ list: ItemList | null; items: string[] }>;
  /** Creates an item, in a parent's list or its collection, after an item (null: first; undefined: last). Returns its source id. */
  add(input: { collection: string; values: Record<string, EditValue>; list?: ItemList; after?: string | null }, session: EditorSession): Promise<{ id: string }>;
  /** Puts the items of a list (or a collection) in this order; every item of it, once */
  reorder(input: { collection: string; items: string[]; list?: ItemList }, session: EditorSession): Promise<void>;
  /** Unpublishes an item where its content type has a status; deletes it otherwise */
  remove(input: { collection: string; id: string }, session: EditorSession): Promise<{ result: "unpublished" | "deleted" }>;
}

/** A refused operation; statusCode says why (400 input, 404 unknown, 409 changed meanwhile, 501 unsupported) */
export class ItemEditError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

const PUBLISHED = "published";

/** The status value that takes an item out of the release */
export function unpublishedValue(field: ContentField): string {
  const options = field.options ?? [];
  return ["draft", "archived"].find((v) => options.includes(v)) ?? options.find((v) => v !== PUBLISHED) ?? "draft";
}

const asEditValue = (value: unknown): EditValue =>
  value === undefined || value === null ? null
    : typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value
    : JSON.stringify(value);

/** A list's ids: plain ids, or references ({ collection, id }) to items of this collection */
function idsIn(value: unknown, collection: string): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") ids.push(entry);
    else if (entry && typeof entry === "object" && (entry as { collection?: unknown }).collection === collection) ids.push(String((entry as { id: unknown }).id));
  }
  return ids;
}

export function createItemEditor(config: ItemEditorConfig): ItemEditor {
  const typeOf = (snap: ItemSnapshot, collection: string): ContentType | undefined =>
    config.contentTypes?.find((t) => t.collection === collection) ?? snap.map.contentTypes?.find((t) => t.collection === collection);
  const kindField = (type: ContentType, kind: ContentField["kind"]) => type.fields.find((f) => f.kind === kind);

  const requireType = (snap: ItemSnapshot, collection: string): ContentType => {
    const type = typeOf(snap, collection);
    if (!type) throw new ItemEditError(404, `${collection} has no content type, so its items can't be added or removed here`);
    return type;
  };

  const itemOf = (snap: ItemSnapshot, collection: string, id: string) => {
    const item = snap.collections[collection]?.find((i) => i.id === id);
    if (!item) throw new ItemEditError(404, `${collection}/${id} isn't in the release`);
    return item;
  };

  /** The record behind an item, and the source of one of its value fields */
  const recordOf = (snap: ItemSnapshot, collection: string, id: string) => {
    const entry = snap.map.collections[collection]?.items[id];
    return {
      collection: entry?.collection ?? snap.map.collections[collection]?.source?.collection ?? collection,
      id: entry?.id ?? id,
      fields: entry?.fields ?? {}
    };
  };
  const valueRef = (snap: ItemSnapshot, collection: string, id: string, field: string): SourceFieldRef => {
    const record = recordOf(snap, collection, id);
    return record.fields[field] ?? { collection: record.collection, id: record.id, field };
  };

  /** The ids of a list, in order: the parent's field, or the collection by its sort field */
  const idsOf = (snap: ItemSnapshot, collection: string, list: ItemList | undefined, type: ContentType): string[] => {
    if (list) {
      const ids = idsIn(itemOf(snap, list.collection, list.id)[list.field], collection);
      if (!ids) throw new ItemEditError(400, `${list.collection}/${list.id}: ${list.field} isn't a list of ${collection}`);
      return ids;
    }
    const sort = kindField(type, "sort")?.field;
    const items = [...(snap.collections[collection] ?? [])];
    if (sort) items.sort((a, b) => (Number(a[sort] ?? Infinity) || Infinity) - (Number(b[sort] ?? Infinity) || Infinity));
    return items.map((i) => i.id);
  };

  const check = (result: EditResult, what: string) => {
    if (result.status === "conflict") throw new ItemEditError(409, `${what} changed in the source meanwhile; reload and try again`);
    if (result.status === "rejected") throw new ItemEditError(result.code ?? 400, `${what}: ${result.message}`);
  };

  /** Where a list's sort values start: its lowest one (sort is shared by a collection; only a list's own order matters) */
  const firstSort = (snap: ItemSnapshot, collection: string, sortField: string, ids: string[]) => {
    const values = ids.map((id) => Number(itemOf(snap, collection, id)[sortField] ?? NaN)).filter(Number.isFinite);
    return values.length ? Math.min(...values) : 1;
  };

  /** Writes consecutive sort values in this order, from the list's first one; null is a slot taken by a new item */
  async function renumber(snap: ItemSnapshot, collection: string, sortField: string, ids: Array<string | null>, session: EditorSession) {
    const first = firstSort(snap, collection, sortField, ids.filter((id): id is string => id !== null));
    for (const [index, id] of ids.entries()) {
      if (id === null) continue;
      const value = first + index;
      const before = itemOf(snap, collection, id)[sortField];
      if (before === value) continue;
      check(await config.editor.write({ ref: valueRef(snap, collection, id, sortField), value, basedOn: asEditValue(before) }, session), `${collection}/${id}`);
    }
  }

  return {
    async describe(collection) {
      return typeOf(await config.snapshot(), collection) ?? null;
    },

    async listOf(collection, id) {
      const snap = await config.snapshot();
      const type = requireType(snap, collection);
      // A parent whose references field holds the item
      for (const [parentCollection, items] of Object.entries(snap.collections)) {
        for (const parent of items) {
          for (const [field, value] of Object.entries(parent)) {
            const ids = idsIn(value, collection);
            if (ids?.includes(id) && snap.map.collections[parentCollection]?.items[parent.id]?.fields?.[field]?.via) {
              return { list: { collection: parentCollection, id: parent.id, field }, items: ids };
            }
          }
        }
      }
      return { list: null, items: idsOf(snap, collection, undefined, type) };
    },

    async add({ collection, values, list, after }, session) {
      if (!config.editor.create) throw new ItemEditError(501, "The source's editor can't create records");
      const snap = await config.snapshot();
      const type = requireType(snap, collection);
      const missing = type.fields.filter((f) => f.required && !["status", "sort", "slug", "references"].includes(f.kind) && (values[f.field] === undefined || values[f.field] === null || values[f.field] === ""));
      if (missing.length) throw new ItemEditError(400, `A new ${collection} item needs ${missing.map((f) => f.label ?? f.field).join(", ")}`);
      const known = new Set(type.fields.map((f) => f.field));
      const unknown = Object.keys(values).filter((f) => !known.has(f));
      if (unknown.length) throw new ItemEditError(400, `${collection} has no field ${unknown.join(", ")}`);

      const ids = idsOf(snap, collection, list, type);
      let at = ids.length;
      if (after === null) at = 0;
      else if (after !== undefined) {
        const index = ids.indexOf(after);
        if (index < 0) throw new ItemEditError(409, `${collection}/${after} is no longer in that list; reload and try again`);
        at = index + 1;
      }

      const sourceCollection = snap.map.collections[collection]?.source?.collection
        ?? Object.values(snap.map.collections[collection]?.items ?? {})[0]?.collection
        ?? collection;
      const data: Record<string, unknown> = { ...(await config.createDefaults?.(collection, session, sourceCollection)) };
      for (const field of type.fields) {
        if (values[field.field] !== undefined) data[field.field] = values[field.field];
      }
      const status = kindField(type, "status");
      if (status && data[status.field] === undefined) data[status.field] = PUBLISHED;
      // A child points back to its parent's record (the list's source names it)
      if (list) {
        const listRef = snap.map.collections[list.collection]?.items[list.id]?.fields?.[list.field];
        if (!listRef?.via) throw new ItemEditError(400, `${list.collection}/${list.id}: ${list.field} has no source list to add to`);
        data[listRef.via] = listRef.id;
      }
      const sort = kindField(type, "sort")?.field;
      if (sort) data[sort] = firstSort(snap, collection, sort, ids) + at;

      const source = await config.editor.create(sourceCollection, data, session);
      // The items after it move down one
      if (sort) await renumber(snap, collection, sort, [...ids.slice(0, at), null, ...ids.slice(at)], session);
      return { id: source };
    },

    async reorder({ collection, items, list }, session) {
      const snap = await config.snapshot();
      const type = requireType(snap, collection);
      const sort = kindField(type, "sort")?.field;
      if (!sort) throw new ItemEditError(400, `${collection} has no sort field, so its order can't be changed`);
      const ids = idsOf(snap, collection, list, type);
      const wanted = new Set(items);
      if (wanted.size !== items.length || items.length !== ids.length || ids.some((id) => !wanted.has(id))) {
        throw new ItemEditError(409, "The list changed since the preview was rendered; reload and try again");
      }
      await renumber(snap, collection, sort, items, session);
    },

    async remove({ collection, id }, session) {
      const snap = await config.snapshot();
      const type = requireType(snap, collection);
      const item = itemOf(snap, collection, id);
      const status = kindField(type, "status");
      if (status) {
        const ref = valueRef(snap, collection, id, status.field);
        check(await config.editor.write({ ref, value: unpublishedValue(status), basedOn: asEditValue(item[status.field]) }, session), `${collection}/${id}`);
        return { result: "unpublished" };
      }
      if (!config.editor.delete) throw new ItemEditError(501, `${collection} has no status to unpublish with, and the source's editor can't delete records`);
      const record = recordOf(snap, collection, id);
      await config.editor.delete(record.collection, record.id, session);
      return { result: "deleted" };
    }
  };
}
