# Server (`@cds/server`)

The server package turns content from a source into a published release in an object store. It is a library, not a running service: you call `Publisher.publish()` from a script, a CMS webhook handler, a CI job, etc.

```
server/src/
├── index.ts               Public exports
├── types.ts               Wire types + ContentSource / ObjectStore interfaces
├── utils.ts               deterministicStringify, sha256
├── validation.ts          Ajv validators for the three schemas
├── core/publisher.ts      Publisher (publish, retention, garbage collection)
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
const { deletedObjects, deletedMedia } = await publisher.garbageCollect();
```

## Extension points

The publisher depends on two interfaces only. New CMS integrations and storage targets are added by implementing them.

### `ContentSource`

```ts
interface ContentSource {
  getCollections(): Promise<Record<string, CollectionItem[]>>;
  getMedia(): Promise<SourceMedia[]>;
}

interface SourceMedia {
  virtualPath: string;  // e.g. "banners/hero.png"; extension decides the stored file extension
  content: Buffer;
  mimeType: string;
}
```

A source returns content already shaped as CDS items (`id`, `key`, `translations`, ...). Mapping a CMS's own field names into this shape is the source adapter's job (the "custom mapper" tier in the root README). If the CMS lacks a feature such as per-field translations, the adapter has to emulate it, for example by merging `title_en` / `title_de` into `translations.en.title` / `translations.de.title`.

**Bundled implementation: `FixtureSource`**
Takes `(collections?, media?)` in its constructor and returns them unchanged. When called with no arguments it returns a small built-in data set (`categories` + `products` with two fake PNGs), which is handy in tests. The demo uses it to publish JSON files read from disk.

### `ObjectStore`

```ts
interface ObjectStore {
  writeObject(hash, content: string): Promise<void>;
  writeMedia(hash, ext, content: Buffer): Promise<void>;
  writeRelease(releaseId, manifest): Promise<void>;
  writeChannelManifest(channel, manifest): Promise<void>;

  readRelease(releaseId): Promise<ReleaseManifest | null>;
  listReleases(): Promise<string[]>;
  deleteRelease(releaseId): Promise<void>;

  listObjects(): Promise<string[]>;   // hashes
  deleteObject(hash): Promise<void>;

  listMedia(): Promise<string[]>;     // file names "<hash>.<ext>"
  deleteMedia(filename): Promise<void>;
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

### `publish(channel, releaseId): Promise<PublishResult>`

```ts
interface PublishResult {
  manifest: ReleaseManifest;   // the published release
  artifacts: PublishArtifacts; // pipeline outputs, never written to the store
}
```

`artifacts` is where per-publish outputs for the pipeline go (reports, source maps; see [goals.md](goals.md)). It's empty for now. Store it as a job artifact and don't publish it.

Steps, in order:

1. Load all collections and media from the source.
2. For each collection:
   - wrap the items as `{ schemaVersion: 1, collection, items }`
   - validate against `collection.json` (throws on failure, which aborts the publish)
   - serialize with `deterministicStringify`, hash with SHA-256
   - `store.writeObject(hash, serialized)`
   - record `{ hash, itemCount, size }` (`size` = UTF-8 byte length of the stored string)
3. For each media file: hash the bytes, `store.writeMedia(hash, extname(virtualPath), bytes)`, record `{ hash, size, mimeType }` under its virtual path.
4. Build the release manifest (`createdAt = now`), validate it, and write it to `releases/<releaseId>.json`.
5. Build the channel manifest (`updatedAt = createdAt`), validate it, and write it. **This is the commit point.** Until this write, clients still see the previous release.
6. Apply release retention (below).

Objects and media are written whether or not they already exist. With content addressing, rewriting identical bytes under the same name has no effect on the result. A remote store can skip the upload with a `HEAD` check to save bandwidth.

If a step fails partway, some objects or the release manifest may already be written, but the channel still points at the old release. The leftovers become garbage once they fall outside retention.

### Release retention

After each publish, `listReleases()` is sorted **lexicographically** and the oldest entries beyond `retentionCount` are deleted (manifest files only, not objects).

Lexicographic order counts as chronological only if release IDs sort that way. Use zero-padded timestamps (`2026-10-03T12-00-00Z`, `release_demo_1759492800000`) and avoid IDs such as `release-9` / `release-10`.

Retention is store-wide, not per channel. All channels in one store share one retention window. A channel that hasn't been republished recently can point to a release that retention has deleted.

### `garbageCollect(): Promise<{ deletedObjects, deletedMedia }>`

Mark-and-sweep over the store:

1. Read every remaining release manifest and collect all referenced collection hashes and media hashes.
2. Delete every `objects/<hash>.json` whose hash wasn't collected.
3. Delete every `media/<hash>.<ext>` whose hash (the part before the first `.`) wasn't collected.

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
