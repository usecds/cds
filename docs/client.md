# Client (`@usecds/client`)

The client package keeps a local, verified copy of a channel's active release and serves queries from memory. It works without network access once a release has been synced.

```
client/src/
├── index.ts               Node entry: everything (browser.ts plus the filesystem adapters)
├── browser.ts             Browser and edge entry: no Node APIs
├── types.ts               Wire types + ClientStorage / RemoteDownloader interfaces
├── utils.ts               sha256 (Web Crypto, plain-JS fallback), sha256Sync
├── validation.ts          validators for manifests and collections
├── generated/validators.ts  precompiled from schemas/v1 (scripts/validators.mjs)
├── core/client.ts         CDSClient (initialize, sync, query API)
├── downloaders/
│   ├── http.ts            HttpDownloader
│   └── filesystem.ts      FilesystemDownloader (Node)
└── storage/
    ├── memory.ts          MemoryStorage
    ├── indexeddb.ts       IndexedDBStorage (browsers)
    └── filesystem.ts      FilesystemStorage (Node)
```

The client runs in Node (servers, build scripts, Electron), in browsers (pages, kiosk screens) and on edge runtimes (Deno, Cloudflare Workers); see [Browsers and edge runtimes](#browsers-and-edge-runtimes).

## Quick start

```ts
import { CDSClient, FilesystemStorage, HttpDownloader } from "@usecds/client";

const client = new CDSClient({
  storage: new FilesystemStorage("./cds-cache"),
  downloader: new HttpDownloader("https://cdn.example.com/cds"), // or FilesystemDownloader("./published")
  retentionCount: 3,
});

await client.initialize();               // load last active release from disk (works offline)
const result = await client.sync("production");
if (!result.success) console.warn("sync failed, still serving", client.getActiveRelease()?.releaseId);

const products = await client.getCollection("products");
const shirt = await client.getItemByKey("products", "classic-tshirt");
const title = shirt?.translations.de.title;
const categories = shirt ? await client.resolveReferences(shirt) : [];
const image = await client.getMediaContent("products/tshirt.png"); // Uint8Array | null
```

## Extension points

### `RemoteDownloader`

```ts
interface RemoteDownloader {
  fetchChannelManifest(channel: string, currentEtag?: string):
    Promise<{ manifest: ChannelManifest; etag?: string; notModified?: boolean }>;
  fetchReleaseManifest(releaseId: string): Promise<ReleaseManifest>;
  fetchObject(hash: string): Promise<string>;           // raw text of objects/<hash>.json
  fetchMedia(hash: string, ext: string): Promise<Uint8Array>; // bytes of media/<hash><ext>
}
```

The package includes two, for the two ways a store reaches a frontend ([deployment.md](deployment.md)):

- `HttpDownloader(baseUrl, init?)`: a store served over HTTP(S), e.g. by a CDN. It sends the channel manifest's last HTTP ETag as `If-None-Match` and remembers it itself, so an unchanged channel costs a 304. `init` is passed to `fetch` (headers, credentials).
- `FilesystemDownloader(baseDir)` (Node only): a store in a local folder (the layout `FilesystemStore` writes), such as a release committed to the site's repository. It uses the release ID as the ETag.

`HttpDownloader` takes a third argument, `fetchImpl`, that replaces the global `fetch` (e.g. to sign requests). `@usecds/s3` builds on it: `S3Downloader({ endpoint, bucket, prefix, accessKeyId, secretAccessKey, region? })` reads a private bucket with SigV4-signed GETs, using a device group's read-only key ([deployment.md](deployment.md#s3-a-bucket-per-tenant-a-read-key-per-device-group)).

Another source (an authenticated API, an archive) implements the interface itself. Important details:

- `fetchObject` **must return the exact bytes** the server stored. Don't parse and re-stringify the JSON, or the hash check will fail.
- **ETag semantics.** `sync()` passes the *active release ID* as `currentEtag`, not an HTTP ETag (the `etag` the downloader returns is ignored). `FilesystemDownloader` compares it to `manifest.releaseId`; `HttpDownloader` keeps the HTTP ETag itself instead.
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
| `MemoryStorage()` | Tests, short-lived processes, edge runtimes | `Map`s in memory; lost on exit |
| `IndexedDBStorage({ name?, indexedDB? })` | Browsers: pages, kiosk screens | One IndexedDB database (`name`, default `"cds"`) with the stores `objects`, `media`, `releases`, `channels`, `meta` (the active release ID); each write is its own transaction |
| `FilesystemStorage(baseDir)` (Node only) | Kiosks, servers, build steps | `objects/<hash>.json`, `media/<hash>.bin` (extension dropped), `releases/<id>.json`, `channels/<channel>.json`, `active_release.txt` |

`FilesystemStorage` sanitizes release IDs and channel names the same way the server store does (`[^a-zA-Z0-9_-]` → `_`).

## `CDSClient`

```ts
new CDSClient({ storage, downloader, retentionCount?: number /* default 3 */, target?: string, syncLock?: string })
```

### `initialize(): Promise<void>`

Reads the active release ID from storage, loads and validates that release manifest, then reads every collection object into an in-memory cache. Call it once at startup, **before** the first `sync()`. Without it the client starts empty and the first sync re-downloads the whole release.

On error (corrupt manifest), the client logs it and starts empty. A collection whose object is missing or invalid is logged and skipped, and queries against it return `[]`.

### `sync(channel): Promise<SyncResult>`

```ts
interface SyncResult { success: boolean; updated: boolean; releaseId?: string; error?: Error }
```

`sync()` **never throws**. Any failure comes back as `{ success: false, updated: false, error }`, and the previously active release stays in place, so the app keeps serving the last good content.

Where `navigator.locks` exists (browsers in a secure context, Node 24+), syncs run one at a time under the Web Lock `syncLock` (default `"cds-sync"`), so tabs and windows sharing one `IndexedDBStorage` don't sync over each other. Clients with separate storages can use their own lock name.

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
       fetchObject → sha256 of its UTF-8 bytes must equal hash → JSON.parse → validate collection
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
| `use(collection)` | A `CollectionHandle` for reading items by key: `get(key)` (item or `null`), `has(key)`, `all()`. See [Reading by handle](#reading-by-handle) |
| `useLocale(locale, options?)` | The release in one language: `use(collection)` gives items with their texts as fields, resolved along fallbacks; `locales()`, `media(path)`. See [Reading in one language](#reading-in-one-language) |
| `getLocales()` | Sorted union of all locale keys across all items |
| `resolveReferences(item)` | Referenced items, in order; dangling references are skipped |
| `getMediaContent(virtualPath)` | `Uint8Array` from storage, or `null` if the path or file is unknown (in Node, `Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)` gives a `Buffer` view without copying) |
| `getMediaInfo(virtualPath, locale?)` | `MediaInfo`: path, hash, size, MIME type, plus `width`, `height`, `focalPoint`, `focalPoints`, `variants` (sizes rendered at publish), and `alt` / `description` in that locale from the `_media` collection. Fields that aren't set (or are empty in that locale) are left out. `null` if the path isn't in the release. |
| `getRoutes()` | All routes: `{ id, key, paths: { [locale]: path }, page?, redirect? }`; empty without `_routes` |
| `getAlternates(routeId)` | Paths of a route per locale (hreflang, language switcher) |
| `resolveRoute(path)` | Route, locale and page for an exact path; redirects followed to their final target (`redirect: { path, status }`); `null` if unknown. Async. |
| `getPage(pageId, locale)` | Page title, description and texts, with its blocks in order: `{ key, type, texts, items: [{ collection, item }], media, links, settings }`. A `source` block gets its full collection. Async. |
| `getMenu(key, locale)` | A menu as a tree of `{ id, key, label, href?, external, children }` with hrefs resolved for the locale; entries without a label or path in that locale are left out. `null` if there's no such menu. |
| `resolveLink(id, locale)` | One `_menu` item as `{ label, href?, external }` (e.g. for block links); `null` if hidden in that locale |
| `getJsonLd(collection, item, locale)` | schema.org JSON-LD data for the item (own `_jsonld` reference or the collection's default), with `@context`; no URLs: images carry `_media` (virtual path) for the generator to replace. `null` if no definition applies. Async. |
| `getTranslationSummary()` | The release's translation completeness summary, or `null` |
| `getTranslationStatus(item, locale, field)` | `{ status, stale }` from the item's `_provenance` translation marker (`status: null` without a marker). Staleness is detected via `sourceHash` only. The publisher's previous-release fallback shows up in the build report, not here. |

The query API above reads raw items: `item.translations[locale]` is `undefined` when an item lacks that locale. `useLocale()` resolves fallbacks for you.

### Reading by handle

A frontend that fills fixed places in its layout (a contact text, a WiFi QR code) reads them by item key, the handle every deployment shares:

```ts
const snippets = client.use("snippets");
const qrcodes = client.use("qrcodes");

snippets.get("contact-info"); // item or null
qrcodes.get("wifi");
```

A handle holds only the collection name. Every read sees the active release at that moment (and a preview's overlay), so a handle taken before `sync()` reads the new release afterwards. The client keeps no "current collection": two handles never affect each other, also when components read concurrently. Reads are synchronous; the data is in memory.

### Reading in one language

`useLocale()` reads like `use()`, but returns each item with its texts as fields, in one language:

```ts
const de = client.useLocale("de-DE");
const contact = de.use("snippets").get("contact-info");
contact?.text;             // "Rufen Sie uns an", or the English text if there is no German one
contact?.$locales.text;    // "de": where the text came from
de.locales();              // ["de-DE", "de", "en"] for a release with de and en (source locale en)
de.media(post.cover)?.alt; // alt text along the same fallbacks
```

- **Fallbacks, in order:** the requested locale, its language (`de` for `de-DE`), the language's other regions (`de-AT`), `options.fallback` (e.g. `["en"]`), then the release's source locale. `{ fallback: false }` reads the requested locale only. Matching ignores case and `_` vs `-`; the release's spelling is used.
- **Per text:** each text falls back on its own, so a half-translated item shows the translated texts and fills in the rest. An empty string counts as missing.
- **Missing content is `null`.** `get(key)` is `null` when there is no item with that key (not published, a draft, or never created). A text that none of the locales has is `null`, and the item has every text field it has in any locale, so its shape doesn't depend on the language. What a place shows without content (nothing, a default, a placeholder) is the frontend's decision.
- Values (non-text fields: `kind`, `url`, media paths) are on the item as they are. Like `use()`, a view holds no release: every read sees the active release at that moment.
- `localize(item, locales)` and `resolveLocales(locale, available, sourceLocale, options)` are exported for frontends that read items another way.

### Preview edits: `EditOverlay`

A preview shows an edit as soon as it is saved in the source, before a release includes it. `setOverlay(overlay)` lays an `EditOverlay` over the active release: every read above sees the edited values. The release itself is never changed (overlaid items are copies), and `getPublishedCollection(name)` still returns the release's own items.

```ts
const overlay = new EditOverlay();
client.setOverlay(overlay);
overlay.set({ collection: "_blocks", id: "b_hero", path: "translations.en.title", value: "Welcome back" });
// on each newly activated release: drop what it makes redundant
overlay.prune((name) => client.getPublishedCollection(name), Date.parse(release.sourceReadAt ?? release.createdAt));
```

`prune` drops edits the release contains, and every edit saved before the release's source was read (`sourceReadAt`): the release has the source's state from then on, including later changes to an edited value. Values are addressed by `FieldAddress` (`{ collection, id, path }`); `formatAddress` / `parseAddress` turn it into `collection/id/path` (each part URI-encoded) and back, e.g. for a `data-` attribute on the element that shows the value.

## Browsers and edge runtimes

`@usecds/client` has two entry points, chosen by the package's `exports` conditions:

| Condition | Entry | Contains |
| --- | --- | --- |
| `browser`, `worker`, `workerd`, `deno` | `dist/browser.js` | everything except `FilesystemStorage` and `FilesystemDownloader`; no Node APIs |
| `default` (Node) | `dist/index.js` | everything |

```ts
import { CDSClient, IndexedDBStorage } from "@usecds/client";
import { S3Downloader } from "@usecds/s3/downloader";

const client = new CDSClient({
  storage: new IndexedDBStorage({ name: "lobby-screen" }),
  downloader: new S3Downloader({ endpoint, bucket, prefix, accessKeyId, secretAccessKey }),
});
await client.initialize(); // the stored release, without network
await client.sync("production");
```

- **Hashing:** `sha256()` uses Web Crypto (`crypto.subtle`), in Node too. A page served over plain `http` (a kiosk on a LAN address) isn't a secure context and has no `crypto.subtle`; there the client hashes in plain JavaScript (`@noble/hashes`), with the same results, more slowly. `sha256Sync()` is the plain-JS hash, used for short texts in synchronous APIs (stale translations).
- **Validation:** the validators are precompiled from `schemas/v1` at build time (`pnpm --filter @usecds/client validators`; a test fails when they're stale). Nothing is compiled at runtime, so the client runs under a strict Content Security Policy and on Workers, which forbid `eval`.
- **Media** is `Uint8Array` everywhere (`ClientStorage`, `RemoteDownloader`, `getMediaContent`).
- **Size:** the browser bundle is about 67 kB minified, 14 kB gzip; `tests/browser-bundle.test.ts` fails above 15,626 bytes gzip. The validators are two thirds of it.
- **Tested in:** Chromium and WebKit (`pnpm test:e2e`, against an S3 server: e2e/README.md), Deno (`tests/deno.test.ts`, skipped without `deno`), and Node with `fake-indexeddb`.

## Current limitations

- **Local GC:** pruning deletes old *release manifests* only. Objects and media they referenced stay in storage indefinitely.
- **Rollback:** older release manifests are kept locally, but there is no public API to activate one. Rolling back today means republishing the old release ID to the channel on the server.
- **Sequential downloads:** missing objects and media are fetched one after another.
- **Memory:** the whole active release (all collections) is held in memory; media is read from storage on demand.
