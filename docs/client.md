# Client (`@cds/client`)

The client package keeps a local, verified copy of a channel's active release and serves queries from memory. It works without network access once a release has been synced.

```
client/src/
├── index.ts               Public exports
├── types.ts               Wire types + ClientStorage / RemoteDownloader interfaces
├── utils.ts               sha256
├── validation.ts          Ajv validators (with fallback schemas)
├── core/client.ts         CDSClient (initialize, sync, query API)
└── storage/
    ├── memory.ts          MemoryStorage
    └── filesystem.ts      FilesystemStorage
```

> The client currently uses Node's `crypto` and `Buffer`, so it runs in Node (servers, build scripts, Electron, kiosks). A browser build would need a WebCrypto-based hash and an IndexedDB storage adapter.

## Quick start

```ts
import { CDSClient, FilesystemStorage } from "@cds/client";

const client = new CDSClient({
  storage: new FilesystemStorage("./cds-cache"),
  downloader: new MyHttpDownloader("https://cdn.example.com/cds"), // you provide this, see below
  retentionCount: 3,
});

await client.initialize();               // load last active release from disk (works offline)
const result = await client.sync("production");
if (!result.success) console.warn("sync failed, still serving", client.getActiveRelease()?.releaseId);

const products = await client.getCollection("products");
const shirt = await client.getItemByKey("products", "classic-tshirt");
const title = shirt?.translations.de.title;
const categories = shirt ? await client.resolveReferences(shirt) : [];
const image = await client.getMediaContent("products/tshirt.png"); // Buffer | null
```

## Extension points

### `RemoteDownloader` (you implement this)

```ts
interface RemoteDownloader {
  fetchChannelManifest(channel: string, currentEtag?: string):
    Promise<{ manifest: ChannelManifest; etag?: string; notModified?: boolean }>;
  fetchReleaseManifest(releaseId: string): Promise<ReleaseManifest>;
  fetchObject(hash: string): Promise<string>;           // raw text of objects/<hash>.json
  fetchMedia(hash: string, ext: string): Promise<Buffer>; // bytes of media/<hash><ext>
}
```

The package doesn't include a downloader. The demo and the integration test each contain a small one that reads from a local directory. An HTTP version is a thin wrapper around `fetch`:

```ts
class HttpDownloader implements RemoteDownloader {
  constructor(private base: string) {}
  async fetchChannelManifest(channel: string, etag?: string) {
    const res = await fetch(`${this.base}/channels/${channel}/manifest.json`,
      { headers: etag ? { "If-None-Match": etag } : {} });
    if (res.status === 304) return { manifest: null as any, notModified: true };
    return { manifest: await res.json(), etag: res.headers.get("etag") ?? undefined };
  }
  async fetchReleaseManifest(id: string) { return (await fetch(`${this.base}/releases/${id}.json`)).json(); }
  async fetchObject(hash: string)        { return (await fetch(`${this.base}/objects/${hash}.json`)).text(); }
  async fetchMedia(hash: string, ext: string) {
    return Buffer.from(await (await fetch(`${this.base}/media/${hash}${ext}`)).arrayBuffer());
  }
}
```

Important details:

- `fetchObject` **must return the exact bytes** the server stored. Don't parse and re-stringify the JSON, or the hash check will fail.
- **ETag semantics.** `sync()` currently passes the *active release ID* as `currentEtag`, not a stored HTTP ETag (the `etag` the downloader returns is ignored). The bundled downloaders therefore compare `currentEtag` to `manifest.releaseId`. With a real HTTP ETag, the downloader has to remember the last ETag itself, or the client has to be extended to persist it.
- When `notModified` is `true`, `manifest` is not read.

### `ClientStorage`

```ts
interface ClientStorage {
  saveObject / readObject / hasObject           // collection JSON by hash
  saveMedia  / readMedia  / hasMedia            // media bytes by hash
  saveRelease / readRelease / listReleases / deleteRelease
  getActiveReleaseId / setActiveReleaseId       // the "current release" pointer
  saveChannelManifest / readChannelManifest
}
```

| Adapter | Use for | Layout / behaviour |
| --- | --- | --- |
| `MemoryStorage()` | Tests, short-lived processes | `Map`s in memory; lost on exit |
| `FilesystemStorage(baseDir)` | Kiosks, servers, build steps | `objects/<hash>.json`, `media/<hash>.bin` (extension dropped), `releases/<id>.json`, `channels/<channel>.json`, `active_release.txt` |

`FilesystemStorage` sanitizes release IDs and channel names the same way the server store does (`[^a-zA-Z0-9_-]` → `_`).

## `CDSClient`

```ts
new CDSClient({ storage, downloader, retentionCount?: number /* default 3 */, target?: string })
```

### `initialize(): Promise<void>`

Reads the active release ID from storage, loads and validates that release manifest, then reads every collection object into an in-memory cache. Call it once at startup, **before** the first `sync()`. Without it the client starts empty and the first sync re-downloads the whole release.

On error (corrupt manifest), the client logs it and starts empty. A collection whose object is missing or invalid is logged and skipped, and queries against it return `[]`.

### `sync(channel): Promise<SyncResult>`

```ts
interface SyncResult { success: boolean; updated: boolean; releaseId?: string; error?: Error }
```

`sync()` **never throws**. Any failure comes back as `{ success: false, updated: false, error }`, and the previously active release stays in place, so the app keeps serving the last good content.

Algorithm:

```
1. fetchChannelManifest(channel, activeReleaseId)
     notModified ─────────────────────────────────▶ { success, updated: false }
2. validate channel manifest; require schemaVersion === 1
3. releaseId === active? ── save channel manifest ─▶ { success, updated: false }
4. fetchReleaseManifest(releaseId); validate
   target set and not in manifest.targets? ─▶ { success: false } (release refused)
5. STAGE (in memory, nothing written yet):
     for each collection hash not in storage:
       fetchObject → sha256 must equal hash → JSON.parse → validate collection
     for each media hash not in storage:
       fetchMedia  → sha256 must equal hash
   any failure here aborts the sync with storage untouched
6. COMMIT:
     save staged objects and media
     save release manifest, save channel manifest
     setActiveReleaseId(releaseId)          ← switch point
     reload in-memory cache
7. prune local release manifests beyond retentionCount (never the active one)
                                              ─▶ { success, updated: true, releaseId }
```

Because downloads are keyed by hash, a release that changes one collection downloads one object. Unchanged collections and media are already in storage and are skipped. The integration test checks this with fetch counters.

The switch is atomic at the level of the active-release pointer: readers of the in-memory cache see either the old release or the new one, never a mix. On disk, staged files are written before the pointer moves, so a crash during commit leaves extra, unreferenced files but a valid active release.

### Query API

All queries read from the in-memory cache of the **active** release and need no I/O (`getMediaContent` is the exception).

| Method | Returns |
| --- | --- |
| `getActiveRelease()` | Active `ReleaseManifest` or `null` |
| `getCollectionsList()` | Collection names in the active release |
| `getCollection(name)` | `CollectionItem[]` (empty if unknown). Returns the cached array; treat it as read-only |
| `getItemByKey(collection, key)` | Item or `null` (linear scan) |
| `getItemById(collection, id)` | Item or `null` (linear scan) |
| `getLocales()` | Sorted union of all locale keys across all items |
| `resolveReferences(item)` | Referenced items, in order; dangling references are skipped |
| `getMediaContent(virtualPath)` | `Buffer` from storage, or `null` if the path or file is unknown |
| `getMediaInfo(virtualPath, locale?)` | `MediaInfo`: path, hash, size, MIME type, plus `width`, `height`, `focalPoint`, `focalPoints`, and `alt` / `description` in that locale from the `_media` collection. Fields that aren't set (or are empty in that locale) are left out. `null` if the path isn't in the release. |
| `getTranslationSummary()` | The release's translation completeness summary, or `null` |
| `getTranslationStatus(item, locale, field)` | `{ status, stale }` from the item's `_provenance` translation marker (`status: null` without a marker). Staleness is detected via `sourceHash` only. The publisher's previous-release fallback shows up in the build report, not here. |

The query API leaves locale fallback to the application. `item.translations[locale]` is `undefined` when an item lacks that locale.

## Current limitations

- **Local GC:** pruning deletes old *release manifests* only. Objects and media they referenced stay in storage indefinitely.
- **Rollback:** older release manifests are kept locally, but there is no public API to activate one. Rolling back today means republishing the old release ID to the channel on the server.
- **No browser/IndexedDB adapter yet**, and hashing depends on Node `crypto`.
- **Sequential downloads:** missing objects and media are fetched one after another.
- **Memory:** the whole active release (all collections) is held in memory; media is read from storage on demand.
