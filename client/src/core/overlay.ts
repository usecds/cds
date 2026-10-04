import { CollectionItem } from "../types.js";

/**
 * The address of one published value: collection, item id, and the field path inside the item
 * ("translations.en.title"). Frontends mark editable text with it; the source map turns it into
 * the source field an edit changes.
 */
export interface FieldAddress {
  collection: string;
  id: string;
  path: string;
}

/** "collection/id/path", each part URI-encoded, e.g. for a data attribute */
export function formatAddress(address: FieldAddress): string {
  return [address.collection, address.id, address.path].map(encodeURIComponent).join("/");
}

export function parseAddress(value: string): FieldAddress | null {
  const parts = value.split("/");
  if (parts.length !== 3 || parts.some((p) => !p)) return null;
  const [collection, id, path] = parts.map(decodeURIComponent);
  return { collection, id, path };
}

export interface OverlayEdit extends FieldAddress {
  value: unknown;
  savedAt?: number; // epoch ms the edit was saved in the source (default: when it was set)
}

/**
 * Unpublished edits laid over a release, for previews only: an edit that was saved in the source
 * shows immediately, until a release includes it. A release never changes; overlaid items are copies.
 */
export class EditOverlay {
  private edits = new Map<string, OverlayEdit>();
  private version = 0;

  set(edit: OverlayEdit): void {
    this.edits.set(formatAddress(edit), { savedAt: Date.now(), ...edit });
    this.version++;
  }

  delete(address: FieldAddress): void {
    if (this.edits.delete(formatAddress(address))) this.version++;
  }

  clear(): void {
    this.edits.clear();
    this.version++;
  }

  list(): OverlayEdit[] {
    return [...this.edits.values()];
  }

  /** Changes on every set, delete and clear, so overlaid views can be cached */
  get revision(): number {
    return this.version;
  }

  /**
   * Drops edits a release makes redundant: those it already contains, and all edits saved before
   * it was published (it has the source's state from then on, including later changes to an
   * edited value). Call it when a new release becomes active.
   */
  prune(getItems: (collection: string) => CollectionItem[], publishedAt?: number): void {
    for (const edit of this.list()) {
      if (publishedAt !== undefined && edit.savedAt !== undefined && edit.savedAt <= publishedAt) {
        this.delete(edit);
        continue;
      }
      const item = getItems(edit.collection).find((i) => i.id === edit.id);
      if (item && readPath(item, edit.path) === edit.value) this.delete(edit);
    }
  }

  /** The items with this overlay's edits for the collection applied (copies; unchanged items are reused) */
  apply(collection: string, items: CollectionItem[]): CollectionItem[] {
    const edits = this.list().filter((e) => e.collection === collection);
    if (!edits.length) return items;
    return items.map((item) => {
      const own = edits.filter((e) => e.id === item.id);
      if (!own.length) return item;
      const copy = structuredClone(item);
      for (const edit of own) writePath(copy, edit.path, edit.value);
      return copy;
    });
  }
}

export function readPath(item: unknown, path: string): unknown {
  let current: any = item;
  for (const key of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    current = current[key];
  }
  return current;
}

function writePath(item: Record<string, any>, path: string, value: unknown): void {
  const keys = path.split(".");
  let current: Record<string, any> = item;
  for (const key of keys.slice(0, -1)) {
    if (current[key] === null || typeof current[key] !== "object") current[key] = {};
    current = current[key];
  }
  current[keys[keys.length - 1]] = value;
}
