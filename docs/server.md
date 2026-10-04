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
├── core/translations.ts   Translation completeness and stale detection
├── core/targets.ts        Target definitions: built-in default, loadTargets, additive merge
├── core/content-report.ts Checks targets against content (requirements, recommendations)
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

| Option | Purpose |
| --- | --- |
| `sourceLocale` | Language of the original content, for [translation completeness](#translation-completeness). Usually a runtime argument of the publish job. |
| `targets` | Target definitions (default + named), usually from `loadTargets(dir)` with the folder as a runtime argument. Built-in defaults apply if there's no default target. See [Targets](#targets). |

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
| `content` | Always: the content report (see [Targets](#targets)) |
| `targets` | Always: the effective (merged) target definitions, e.g. as input for the image project |

Steps, in order:

1. Load all collections, media and (if provided) the source map from the source. Keep only **referenced** media (see [schemas.md](schemas.md#which-media-is-published)); drop the rest and its `_media` entries, with a warning in the content report.
2. For each collection, in memory:
   - wrap the items as `{ schemaVersion: 1, collection, items }`
   - validate against `collection.json` (throws on failure, which aborts the publish)
   - serialize with `deterministicStringify`, hash with SHA-256
   - record `{ hash, itemCount, size }` (`size` = UTF-8 byte length of the serialized string)
3. Hash each published media file and record `{ hash, size, mimeType }` under its virtual path. If a `_media` collection exists, validate it (see [schemas.md](schemas.md#media-metadata-_media-collection-media-metadatajson)), validate `_jsonld` definitions (see [schemas.md](schemas.md#json-ld-definitions-_jsonld-collection-jsonldjson)) the optional site structure (see [schemas.md](schemas.md#site-structure-_routes-_pages-_blocks)) and menus (see [schemas.md](schemas.md#menus-_menu)); a problem throws before anything is written.
4. Measure translation completeness (below), comparing against the release the channel currently points to.
5. Check the targets and build the content report. **An unmet requirement throws `PublishRequirementsError` here, before anything is written.** The error carries the artifacts, so the pipeline can still store the report.
6. Write objects (`store.writeObject`) and media (`store.writeMedia(hash, extname(virtualPath), bytes)`).
7. Build the release manifest (`createdAt = now`, translation summary, satisfied `targets`), validate it, and write it to `releases/<releaseId>.json`.
8. Build the channel manifest (`updatedAt = createdAt`), validate it, and write it. **This is the commit point.** Until this write, clients still see the previous release.
9. Apply release retention (below).

Objects and media are written whether or not they already exist. With content addressing, rewriting identical bytes under the same name has no effect on the result. A remote store can skip the upload with a `HEAD` check to save bandwidth.

If a write fails partway, some objects or the release manifest may already be written, but the channel still points at the old release. The leftovers become garbage once they fall outside retention.

### Translation completeness

Every publish measures how complete each language is, relative to a **source locale**.

**Source locale**, first match wins:
1. `options.sourceLocale` passed to `publish()`
2. `ContentSource.getSourceLocale()`
3. inferred from `_provenance` translation markers, if they name exactly one origin language (locales marked `original` plus all `from` values)
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

### Targets

A target definition is a contract between one consumer (website, kiosk, TV app) and the content. One publish checks the default target plus 0–n named targets and produces one release. See [goals.md](goals.md) (P7, P10) for the reasoning.

```json
{
  "id": "hotel-web",
  "scope": ["rooms", "site_settings"],
  "locales": { "required": ["en", "de"], "minCompleteness": 1, "maxStale": 0 },
  "collections": {
    "rooms": {
      "minItems": 1,
      "localized": { "type": "object", "required": ["name", "description"] },
      "fields": { "type": "object", "required": ["amenities"] }
    }
  },
  "items": [{ "collection": "site_settings", "key": "homepage" }],
  "recommendations": {
    "rooms": { "localized": { "properties": { "description": { "minLength": 50, "maxLength": 300 } } } }
  },
  "media": {
    "breakpoints": { "mobile": 0, "desktop": 1280 },
    "dpr": [1, 2],
    "presets": { "card": { "aspect": "4:3", "fit": "fill", "widths": { "mobile": 640, "desktop": 400 } } }
  }
}
```

| Section | Checked how | On failure |
| --- | --- | --- |
| `locales.required` | The locale has content within the scope | requirement |
| `locales.minCompleteness` / `maxStale` | Translation counts within the scope, for the required locales (or all non-source locales) | requirement |
| `collections` | Listed collections must exist; `minItems`; `localized` is a JSON Schema for `translations[locale]` per required locale (or the source locale); `fields` is a JSON Schema for the item | requirement |
| `items` | Named items (`collection` + `key`) must exist | requirement |
| `recommendations` | Same as `localized` / `fields`, checked for **every** locale in the content | recommendation |
| `media` | Breakpoints, DPR and presets: the contract for the image processor ([imaging.md](imaging.md)). Validated and merged, not rendered by CDS. | definition error |

Empty values (`""`, `null`) count as missing, as in translation completeness.

**Default and named targets:**
- **Loading:** `loadTargets(dir)` reads `*.json`. `default.json` is the default target and is the only file that may use the id `default`. Definitions can also be passed in code.
- **Built-in default:** if no default target is given, `BUILTIN_DEFAULT_TARGET` applies. It recommends `_media` `alt` (1–125 characters) and `description` (50–300 characters), and `_pages` `title` (1–60) and `description` (50–160).
- **Scope:** the default target applies to everything and can't declare a scope. A named target's `scope` limits its own rules. Rules outside the scope are a definition error.
- **Merging (additive):** a named target's effective definition is the default plus its own rules. Lists are combined, `minCompleteness`/`minItems` take the higher value, `maxStale` the lower, and schemas are combined with `allOf` (both must pass). Nothing is overwritten.
- **Presets and breakpoints:** all targets share one release, so a preset or breakpoint name defined differently in two targets fails the build, and so does a preset width for an undeclared breakpoint.
- **Satisfied:** a named target is satisfied only if the default target is satisfied too. Every published release satisfies all its targets (otherwise the publish fails), and the release manifest lists them in `targets`.
- More than 8 named targets produces a warning.

**Content report** (`artifacts.content`):

```json
{
  "targets": { "default": { "satisfied": true, "requirements": 0, "recommendations": 1 } },
  "issues": [
    { "severity": "recommendation", "target": "default", "issue": "too-long",
      "collection": "_media", "id": "hero.jpg", "locale": "en", "field": "alt",
      "length": 130, "recommended": "1–125 characters",
      "message": "alt is too long: 130 characters (recommended 1–125 characters)",
      "source": "https://cms.example.com/admin/files/7f3a" }
  ],
  "warnings": []
}
```

`issue` is one of `missing`, `too-short`, `too-long`, `invalid`, `missing-collection`, `too-few-items`, `missing-item`, `missing-locale`, `incomplete-locale`, `too-many-stale`, plus the translation issues `untranslated` and `stale` and `meaningless-name`, `jsonld-empty`, `unrouted-page`, `unused-block` and `missing-label` (always recommendations). `meaningless-name` flags published media whose file name (or `_media` name) has no descriptive word: camera and phone defaults (`IMG_2034`, `DSC00012`, `PXL_…`), messenger and screenshot names (`photo_2026-10-01_12-07-10`, `WhatsApp Image …`, `Screenshot …`), AI tool defaults (`ChatGPT Image 24. Sept. 2026, 12_41_16`, `DALL·E …`), UUIDs, hashes, and names made only of dates, numbers or generic words (`image1`, `untitled-copy-final`). It suggests a name from the alt text (`recommended`). See `meaninglessNameReason` and `suggestMediaName`. `source` is a deep link built from the source map, if one is available.

### Publish report

`createPublishReport({ channel, releaseId, artifacts, manifest?, error? })` turns a publish result into one structured report, for both a successful and a failed publish (pass `err.artifacts` and `err` from `PublishRequirementsError`). `renderPublishReportHtml(report)` renders it as a self-contained HTML page (no external resources, light and dark).

| Field | Contents |
| --- | --- |
| `status`, `error` | `published` or `failed`, with the error message |
| `summary` | Failed requirements, recommendations, warnings, targets satisfied, overall translation counts |
| `release` | Collections, items and media in the release (successful publishes only) |
| `targets` | Result per target |
| `translations` | Source locale (and how it was chosen), counts per locale and per collection × locale, items without source |
| `issues` | All content issues (requirements first), each with location, message, recommended range and CMS link |
| `warnings` | E.g. unreferenced media |

The report is pipeline output: store it as a job artifact next to the build, never publish it.

### Source map

A source map links published content back to the source system, e.g. for "edit in CMS" deep links. It's returned as `artifacts.sourceMap` (with the `releaseId` added) and is **never written to the store**, so internal IDs and admin paths stay private.

```ts
interface SourceMap {
  sources: Record<string, { baseUrl?: string }>;           // per adapter
  collections: Record<string, {                              // per CDS collection
    source?: { adapter: string; collection: string };
    items: Record<string, {                                  // per CDS item id
      id: string;
      path?: string;
      fields?: Record<string, SourceFieldRef>;               // per field path in the item
    }>;
  }>;
  media: Record<string, { adapter: string; id: string; path?: string }>; // per virtual path
}

interface SourceFieldRef {
  collection: string; id: string; field: string;            // where the value comes from
  format?: "plain" | "html";                                 // text format, for editors
  editable?: boolean;                                        // false for derived values
}
```

`path` is relative to the source's `baseUrl`, so moving the CMS host changes only the artifact. The publisher passes the map through as is, without checking it against the published content.

`fields` maps a value's path in the CDS item (`translations.en.title`, `interfaces.0.name`) to the source field it comes from. It is what makes a value editable in a preview (goal P13): an edit names the CDS address, and the source map says which source field to change.

### Editing: `SourceEditor` (optional)

The write side of a source adapter. Edits go to the source system, never into a release: releases stay immutable, CDS stores no edits, and the next publish includes them. An adapter without it simply offers no editing.

```ts
interface SourceEditor {
  login(credentials: { email: string; password: string }): Promise<EditorSession>; // the editor's own account
  refresh?(session: EditorSession): Promise<EditorSession>;
  logout?(session: EditorSession): Promise<void>;
  read(ref: SourceFieldRef, session: EditorSession): Promise<string | null>;
  write(edit: SourceEdit, session: EditorSession): Promise<EditResult>;
}

type EditValue = string | number | boolean | null;               // text, or a scalar like a yes/no field
interface SourceEdit { ref: SourceFieldRef; value: EditValue; basedOn: EditValue } // basedOn: what the editor saw
type EditResult =
  | { status: "saved"; value: EditValue }
  | { status: "conflict"; current: EditValue } // the source changed since basedOn: nothing written
  | { status: "rejected"; message: string; code?: number };
```

Structure changes have their own optional interface, `StructureEditor`, in CDS terms (CDS ids):

```ts
interface StructureEditor {
  blockTypes(): string[];
  createPage({ title, slug, status? }, session): Promise<{ page: string }>;
  addBlock({ page, type, after?, texts? }, session): Promise<{ block: string }>; // after: block id, null = top, undefined = end
  reorderBlocks({ page, blocks }, session): Promise<void>;                       // the release's blocks, in the new order
  addMenuEntry({ parent, label, page? | url?, canonical? }, session): Promise<{ entry: string }>; // parent: a menu or an entry
}
```

How pages, blocks and menus are stored is site-specific, so a `StructureEditor` is written next to the site's mapping (its inverse), on top of the adapter's editor. Structure changes can't be shown through an overlay; a preview publishes a new release after them.

Writes run with the editor's session, so the source system applies its own permissions; CDS holds no write credentials. Implemented by `DirectusEditor` in `@cds/directus` ([directus.md](directus.md#editing-directuseditor)).

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
| `validateChannelManifest`, `validateReleaseManifest`, `validateCollection`, `validateTargetDefinition` | Throw an `Error` with Ajv's message on invalid input |

## Current limitations

- Only the filesystem store exists; S3 is planned. Sources: the fixture source here, and `DirectusSource` in `@cds/directus` ([directus.md](directus.md)).
- No locking: two concurrent publishers to the same store can race on the channel manifest and on retention.
- Delta / diff releases (Milestone 2) are not implemented.
