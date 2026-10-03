# Server (`@cds/server`)

The server package turns content from a source into a published release in an object store. It is a library, not a running service: you call `Publisher.publish()` from a script, a CMS webhook handler, a CI job, etc.

```
server/src/
├── index.ts               Public exports
├── types.ts               Wire types + ContentSource / ObjectStore interfaces
├── utils.ts               deterministicStringify, sha256
├── validation.ts          Ajv validators for the three schemas
├── core/publisher.ts      Publisher (publish, retention, garbage collection)
├── core/storage-report.ts analyzeStorage (per-release usage, diffs, orphans)
├── sources/fixture.ts     FixtureSource (in-memory ContentSource)
└── storage/filesystem.ts  FilesystemStore (ObjectStore on local disk)
```

## Quick start

```ts
import { Publisher, FixtureSource, FilesystemStore } from "@cds/server";

const source = new FixtureSource({
  pages: [
    { id: "p1", key: "home", translations: { en: { title: "Home" }, de: { title: "Start" } } }
  ]
}, []);

const store = new FilesystemStore("./published");
const publisher = new Publisher(source, store, { retentionCount: 5 });

const { manifest, artifacts } = await publisher.publish("production", "2026-10-03T12-00-00Z");
const preview = await publisher.garbageCollect({ dryRun: true }); // report only
const { deletedObjects, deletedMedia, freedBytes } = await publisher.garbageCollect();
```

## Extension points

The publisher depends on two interfaces only. New CMS integrations and storage targets are added by implementing them.

### `ContentSource`

```ts
interface ContentSource {
  getCollections(): Promise<Record<string, CollectionItem[]>>;
  getMedia(): Promise<SourceMedia[]>;
  getSourceMap?(): Promise<SourceMap>; // optional, see "Source map" below
  getSourceLocale?(): Promise<string | undefined>; // optional: the CMS's original-content language
}

interface SourceMedia {
  virtualPath: string;  // e.g. "banners/hero.png"; extension decides the stored file extension
  content: Buffer;
  mimeType: string;
}
```

A source returns content already shaped as CDS items (`id`, `key`, `translations`, ...). Mapping a CMS's own field names into this shape is the source adapter's job (the "custom mapper" tier in the root README). If the CMS lacks a feature such as per-field translations, the adapter has to emulate it, for example by merging `title_en` / `title_de` into `translations.en.title` / `translations.de.title`.

**Bundled implementation: `FixtureSource`**
Takes `(collections?, media?, sourceMap?)` in its constructor and returns them unchanged. It provides `getSourceMap()` only when a source map is passed. When called with no arguments it returns a small built-in data set (`categories` + `products` with two fake PNGs), which is handy in tests. The demo uses it to publish JSON files read from disk.

### `ObjectStore`

```ts
interface ObjectStore {
  writeObject(hash, content: string): Promise<void>;
  writeMedia(hash, ext, content: Buffer): Promise<void>;
  writeRelease(releaseId, manifest): Promise<void>;
  writeChannelManifest(channel, manifest): Promise<void>;

  listChannels(): Promise<string[]>;
  readChannelManifest(channel): Promise<ChannelManifest | null>;

  readRelease(releaseId): Promise<ReleaseManifest | null>;
  listReleases(): Promise<string[]>;
  deleteRelease(releaseId): Promise<void>;

  readObject(hash): Promise<string | null>;
  listObjects(): Promise<string[]>;   // hashes
  deleteObject(hash): Promise<void>;
  objectSize(hash): Promise<number | null>;     // bytes, null if missing

  listMedia(): Promise<string[]>;     // file names "<hash>.<ext>"
  deleteMedia(filename): Promise<void>;
  mediaSize(filename): Promise<number | null>;  // bytes, null if missing
}
```

**Bundled implementation: `FilesystemStore(baseDir)`**
Writes the layout described in [schemas.md](schemas.md#storage-layout) under `baseDir`, creating directories as needed. Details:

- Release IDs and channel names are sanitized for file names: any character outside `[a-zA-Z0-9_-]` becomes `_`. A release ID such as `2026-10-03T12:00:00Z` is therefore stored as `2026-10-03T12_00_00Z.json`, and a downloader must apply the same mapping. Stick to `[a-zA-Z0-9_-]` in IDs.
- Manifests are pretty-printed. Collection objects are written byte-for-byte as given, since their hash depends on it.
- Writes go straight to the final path (no temp file + rename).

A future S3 store would implement the same interface. It should set long-lived cache headers on `objects/`, `media/` and `releases/`, and short or no caching on `channels/`.

## `Publisher`

```ts
new Publisher(source: ContentSource, store: ObjectStore, config?: { retentionCount?: number })
```

`retentionCount` defaults to `3`.

### `publish(channel, releaseId, options?): Promise<PublishResult>`

`options.sourceLocale`: the language of the original content, used for [translation completeness](#translation-completeness). Usually passed as a runtime argument of the publish job.

```ts
interface PublishResult {
  manifest: ReleaseManifest;   // the published release
  artifacts: PublishArtifacts; // pipeline outputs, never written to the store
}
```

`artifacts` holds per-publish outputs for the pipeline. Store it as a job artifact and don't publish it. Currently:

| Artifact | Present when |
| --- | --- |
| `sourceMap` | The source implements `getSourceMap()` (see below) |
| `translations` | Always: the full translation report (see below) |

Steps, in order:

1. Load all collections, media and (if provided) the source map from the source.
2. For each collection:
   - wrap the items as `{ schemaVersion: 1, collection, items }`
   - validate against `collection.json` (throws on failure, which aborts the publish)
   - serialize with `deterministicStringify`, hash with SHA-256
   - `store.writeObject(hash, serialized)`
   - record `{ hash, itemCount, size }` (`size` = UTF-8 byte length of the stored string)
3. For each media file: hash the bytes, `store.writeMedia(hash, extname(virtualPath), bytes)`, record `{ hash, size, mimeType }` under its virtual path.
4. Measure translation completeness (below), comparing against the release the channel currently points to.
5. Build the release manifest (`createdAt = now`, including the translation summary), validate it, and write it to `releases/<releaseId>.json`.
6. Build the channel manifest (`updatedAt = createdAt`), validate it, and write it. **This is the commit point.** Until this write, clients still see the previous release.
7. Apply release retention (below).

Objects and media are written whether or not they already exist. With content addressing, rewriting identical bytes under the same name has no effect on the result. A remote store can skip the upload with a `HEAD` check to save bandwidth.

If a step fails partway, some objects or the release manifest may already be written, but the channel still points at the old release. The leftovers become garbage once they fall outside retention.

### Translation completeness

Every publish measures how complete each language is, relative to a **source locale**.

**Source locale**, first match wins:
1. `options.sourceLocale` passed to `publish()`
2. `ContentSource.getSourceLocale()`
3. inferred from `_translation` markers, if they name exactly one origin language (locales marked `original` plus all `from` values)
4. `"en"`

The report says which rule was used (`sourceLocaleOrigin`: `argument` | `source` | `inferred` | `fallback`).

**Counting**, per collection × target locale (every locale in the content except the source):

| Count | Rule |
| --- | --- |
| `expected` | Source-locale fields whose value is a **non-empty string**. Empty and non-string source values (numbers, arrays, objects) are ignored. |
| `missing` | Expected, but the translation is absent, `null` or `""` |
| `translated` | Expected and not missing (includes stale and machine) |
| `machine` | Translated, with marker status `machine` |
| `stale` | Translated, but the source text changed since: the marker's `sourceHash` no longer matches. Without a `sourceHash`, the publisher compares with the channel's current release: the source text changed and the translation didn't. |

Items that have no source-locale entry at all are listed in `itemsWithoutSource` and not counted.

`artifacts.translations` contains the counts per collection, per locale and overall, plus `issues` (every missing or stale field with collection, item id, locale and field) for editors. The release manifest gets only the summary (`sourceLocale`, per-locale counts, overall).

### Source map

A source map links published content back to the source system, e.g. for "edit in CMS" deep links. It's returned as `artifacts.sourceMap` (with the `releaseId` added) and is **never written to the store**, so internal IDs and admin paths stay private.

```ts
interface SourceMap {
  sources: Record<string, { baseUrl?: string }>;           // per adapter
  collections: Record<string, {                              // per CDS collection
    source?: { adapter: string; collection: string };
    items: Record<string, { id: string; path?: string }>;    // per CDS item id
  }>;
  media: Record<string, { adapter: string; id: string; path?: string }>; // per virtual path
}
```

`path` is relative to the source's `baseUrl`, so moving the CMS host changes only the artifact. The publisher passes the map through as is, without checking it against the published content.

### Release retention

After each publish, `listReleases()` is sorted **lexicographically** and the oldest entries beyond `retentionCount` are deleted (manifest files only, not objects). A release that any channel currently points to is **never** deleted, even if it's outside the window.

Lexicographic order counts as chronological only if release IDs sort that way. Use zero-padded timestamps (`2026-10-03T12-00-00Z`, `release_demo_1759492800000`) and avoid IDs such as `release-9` / `release-10`.

Retention is store-wide, not per channel: all channels in one store share one retention window. Channel-pinned releases are kept on top of that window, so the number of stored releases can exceed `retentionCount`.

### `analyzeStorage(): Promise<StorageReport>`

A read-only walk over the store:

| Field | Contents |
| --- | --- |
| `releases[]` | Per retained release, oldest first: `channels` pointing at it, object/media counts, `bytes`, `uniqueBytes` (referenced by no other retained release, so freed if it's deleted), `missing` files, and a `diff` against the previous release (`added` / `removed` file paths, `shared` count) |
| `channels` | `channel → { releaseId, retained }` (`retained: false` means the channel points at a deleted release) |
| `totals` | Count and bytes of all stored objects and media |
| `orphans` | Files referenced by no retained release, with sizes: exactly what GC deletes |

File paths are relative to the storage root (`objects/<hash>.json`, `media/<hash><ext>`). `analyzeStorage` is also exported as a standalone function taking an `ObjectStore`.

### `garbageCollect({ dryRun? }): Promise<GarbageCollectResult>`

Runs `analyzeStorage()` and deletes exactly the files in `report.orphans`. With `dryRun: true` nothing is deleted.

```ts
interface GarbageCollectResult {
  dryRun: boolean;
  deletedObjects: number;  // in a dry run: would be deleted
  deletedMedia: number;
  freedBytes: number;
  report: StorageReport;   // state before deletion
}
```

Media files are matched by hash (the part of the file name before the first `.`).

GC is **not** called by `publish()`. Run it separately, for example after each publish or on a schedule. Don't run it while a publish to the same store is in progress: objects already written for the new, not-yet-manifested release would look unreferenced and get deleted.

## Utilities

| Export | Purpose |
| --- | --- |
| `deterministicStringify(value)` | JSON with recursively sorted object keys and no whitespace; basis for stable hashes |
| `sha256(string \| Buffer)` | Hex SHA-256 digest (Node `crypto`) |
| `validateChannelManifest`, `validateReleaseManifest`, `validateCollection` | Throw an `Error` with Ajv's message on invalid input |

## Current limitations

- Only the filesystem store and fixture source exist. Directus and S3 adapters are planned but not implemented.
- No locking: two concurrent publishers to the same store can race on the channel manifest and on retention.
- Delta / diff releases (Milestone 2) are not implemented.
