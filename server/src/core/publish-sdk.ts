import {
  CollectionItem,
  ContentSource,
  EditResult,
  EditValue,
  EditorSession,
  ObjectStore,
  SourceEditor,
  SourceFieldRef,
  SourceMap,
  SourceUpload
} from "../types.js";
import { Publisher, PublisherConfig, PublishResult } from "./publisher.js";
import { TargetDefinition } from "./targets.js";
import { ContentType, TEXT_KINDS } from "./content-types.js";
import { MediaRenderer } from "./media-variants.js";
import { DEFAULT_SOURCE_LOCALE } from "./translations.js";

export interface PublishSdkConfig {
  /**
   * A fresh source per read: sources may cache what they read (DirectusSource does), and the SDK
   * reads again after it wrote
   */
  source: () => ContentSource;
  editor: SourceEditor;
  /** The caller's session with the source: a login, or a source user's static token ({ accessToken }) */
  session: EditorSession;
  store: ObjectStore;
  targets?: TargetDefinition[];
  /** Renders the image sizes the targets ask for, at release */
  renderer?: MediaRenderer;
  sourceLocale?: string;
  publisher?: PublisherConfig;
  /**
   * The content types of the collections the SDK writes: which field is the key (slug), which are
   * texts and which are files. Needed to create items and to set file fields.
   */
  contentTypes?: ContentType[];
  /** Source fields every created record gets, e.g. its project: (collection) => ({ projects: [{ projects_id: id }] }) */
  createDefaults?: (collection: string) => Record<string, unknown>;
}

/** What a set() did, per field it wrote */
export interface SetResult {
  /** saved or created when every field was written; otherwise the first field's conflict or rejection */
  status: "saved" | "created" | "conflict" | "rejected";
  /** The source record's id */
  id?: string;
  fields: Record<string, EditResult>;
}

export interface SdkCollection {
  readonly collection: string;
  /** The item as the source has it now (the content of the next release), or null */
  get(key: string): Promise<CollectionItem | null>;
  /**
   * Writes values of the item with this key to the source; creates the item when there is none
   * (needs the collection's content type and an editor with create). Values are CDS field names:
   * texts in the source locale, values and file ids (from media.add) for the rest.
   */
  set(key: string, values: Record<string, EditValue>): Promise<SetResult>;
}

export interface PublishSdk {
  use(collection: string): SdkCollection;
  media: {
    /** Uploads an original to the source; set its id in a file field. Sizes are rendered at release. */
    add(file: SourceUpload): Promise<{ id: string }>;
  };
  /** Publishes the source's current content as a new release of the channel */
  publish(channel: string, options?: { releaseId?: string }): Promise<PublishResult>;
}

interface Snapshot {
  collections: Record<string, CollectionItem[]>;
  map: SourceMap;
  locale: string;
}

// The value at a dotted path of an item ("translations.en.title")
function readPath(item: CollectionItem, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => (value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined), item);
}

const asEditValue = (value: unknown): EditValue =>
  value === undefined || value === null ? null
    : typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value
    : JSON.stringify(value);

/** Release IDs sort chronologically (retention keeps the newest) */
const releaseIdNow = () => new Date().toISOString().replace(/[:.]/g, "-");

/**
 * Writes content through a source adapter's editor and publishes it: the same shape as reading
 * (use(collection), by key), but every write goes to the source system, never into a release.
 * Values are found through the source map, and each write is checked against the value the SDK
 * read (a change made meanwhile comes back as a conflict).
 */
export function createPublishSdk(config: PublishSdkConfig): PublishSdk {
  let snapshot: Promise<Snapshot> | undefined;
  const read = () =>
    (snapshot ??= (async () => {
      const source = config.source();
      const [collections, map, locale] = await Promise.all([
        source.getCollections(),
        source.getSourceMap ? source.getSourceMap() : Promise.resolve(undefined),
        config.sourceLocale ?? (source.getSourceLocale ? source.getSourceLocale() : undefined)
      ]);
      if (!map) throw new Error("The source has no source map: the publish SDK can't find where values come from");
      return { collections, map, locale: locale ?? DEFAULT_SOURCE_LOCALE };
    })());
  const stale = () => {
    snapshot = undefined;
  };
  const typeOf = (collection: string) => config.contentTypes?.find((t) => t.collection === collection);

  // The source field behind a field of an item, and the value the SDK read for it
  async function target(collection: string, item: CollectionItem, field: string, snap: Snapshot): Promise<{ ref: SourceFieldRef; basedOn: EditValue } | null> {
    const declared = typeOf(collection)?.fields.find((f) => f.field === field);
    const isText = declared ? TEXT_KINDS.has(declared.kind) : item.translations[snap.locale]?.[field] !== undefined;
    const path = isText ? `translations.${snap.locale}.${field}` : field;
    const entry = snap.map.collections[collection]?.items[item.id];
    const ref = entry?.fields?.[path];
    if (ref) return { ref, basedOn: asEditValue(readPath(item, path)) };
    // A field without a recorded source (a file field: the release holds its media path, the
    // source its file id) is written to the item's record; the basis is the source's own value
    if (entry && declared?.kind === "file") {
      const origin = entry.collection ?? snap.map.collections[collection]?.source?.collection ?? collection;
      const fileRef: SourceFieldRef = { collection: origin, id: entry.id, field };
      return { ref: fileRef, basedOn: await config.editor.read(fileRef, config.session) };
    }
    return null;
  }

  async function create(collection: string, key: string, values: Record<string, EditValue>, snap: Snapshot): Promise<SetResult> {
    const type = typeOf(collection);
    const keyField = type?.fields.find((f) => f.kind === "slug")?.field;
    if (!config.editor.create || !type || !keyField) {
      const why = !config.editor.create ? "the editor can't create records" : `no content type with a slug field for ${collection}`;
      return { status: "rejected", fields: { [key]: { status: "rejected", message: `${collection}/${key} doesn't exist and can't be created: ${why}` } } };
    }
    const sourceCollection = snap.map.collections[collection]?.source?.collection ?? collection;
    const id = await config.editor.create(sourceCollection, { ...config.createDefaults?.(collection), ...values, [keyField]: key }, config.session);
    stale();
    const fields = Object.fromEntries(Object.entries(values).map(([field, value]) => [field, { status: "saved", value } as EditResult]));
    return { status: "created", id, fields };
  }

  return {
    use(collection) {
      return {
        collection,
        async get(key) {
          return (await read()).collections[collection]?.find((i) => i.key === key) ?? null;
        },
        async set(key, values) {
          const snap = await read();
          const item = snap.collections[collection]?.find((i) => i.key === key);
          if (!item) return create(collection, key, values, snap);

          const fields: Record<string, EditResult> = {};
          let status: SetResult["status"] = "saved";
          for (const [field, value] of Object.entries(values)) {
            const found = await target(collection, item, field, snap);
            const result: EditResult = found
              ? await config.editor.write({ ref: found.ref, value, basedOn: found.basedOn }, config.session)
              : { status: "rejected", message: `${collection}/${key}: ${field} has no source field, so it can't be written` };
            fields[field] = result;
            if (result.status !== "saved" && status === "saved") status = result.status;
          }
          stale();
          return { status, id: snap.map.collections[collection]?.items[item.id]?.id ?? item.id, fields };
        }
      };
    },
    media: {
      async add(file) {
        if (!config.editor.upload) throw new Error("The editor can't upload files");
        const id = await config.editor.upload(file, config.session);
        stale();
        return { id };
      }
    },
    async publish(channel, options = {}) {
      const publisher = new Publisher(config.source(), config.store, config.publisher);
      const result = await publisher.publish(channel, options.releaseId ?? releaseIdNow(), {
        ...(config.targets ? { targets: config.targets } : {}),
        ...(config.renderer ? { renderer: config.renderer } : {}),
        ...(config.sourceLocale ? { sourceLocale: config.sourceLocale } : {})
      });
      stale();
      return result;
    }
  };
}
