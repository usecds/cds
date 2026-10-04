# Schemas (v1)

The wire format is defined by three JSON Schema (draft-07) files in [`schemas/v1/`](../schemas/v1/). Both packages compile them with [Ajv](https://ajv.js.org/) (plus `ajv-formats` for `date-time`) and validate every document they write or read. The TypeScript interfaces in `server/src/types.ts` and `client/src/types.ts` mirror these schemas; the two files are identical copies for the shared types.

Every document carries `"schemaVersion": 1`. The schemas pin it with `const: 1`, so a v2 document fails validation on a v1 client instead of being misread.

**Extensibility:** every object in the v1 schemas allows additional properties. New **optional** fields can be added within v1 without breaking existing clients, which validate the fields they know and ignore the rest. Breaking changes (removed, renamed or newly required fields, changed meaning) need a new `schemaVersion`.

## Storage layout

The schemas describe the files under a storage root (a directory today; an S3 bucket or CDN origin later):

```
<storage-root>/
├── channels/<channel>/manifest.json   ChannelManifest  (mutable, polled)
├── releases/<releaseId>.json          ReleaseManifest  (immutable)
├── objects/<sha256>.json              Collection       (immutable, content-addressed)
└── media/<sha256><ext>                raw bytes        (immutable, content-addressed)
```

Only `channels/*/manifest.json` ever changes. Everything else is written once and either kept or deleted, which means it can be cached forever by a CDN.

---

## `channel-manifest.json`

Points a channel at its current release.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `schemaVersion` | integer, `const 1` | yes | |
| `channel` | string | yes | Channel name, e.g. `production` |
| `releaseId` | string | yes | ID of the active release |
| `updatedAt` | string, `date-time` | yes | Set to the release's `createdAt` by the publisher |

Unknown fields are allowed and ignored.

```json
{
  "schemaVersion": 1,
  "channel": "production",
  "releaseId": "2026-09-04T12-00-00Z",
  "updatedAt": "2026-09-04T12:00:00.000Z"
}
```

## `release-manifest.json`

Lists everything that belongs to one release.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `schemaVersion` | integer, `const 1` | yes | |
| `releaseId` | string | yes | |
| `createdAt` | string, `date-time` | yes | |
| `collections` | object of `CollectionMeta` | yes | Keyed by collection name |
| `media` | object of `MediaMeta` | yes | Keyed by virtual path; may be `{}` |
| `translations` | `TranslationSummary` | no | Translation completeness, see below |
| `targets` | array of string | no | Targets whose requirements this release satisfies |

`CollectionMeta`: `{ hash: string, itemCount: integer >= 0, size: integer >= 0 }`. `size` is the byte size of the stored object.
`MediaMeta`: `{ hash: string, size: integer >= 0, mimeType: string }`
`TranslationSummary`: `{ sourceLocale: string, locales: { [locale]: TranslationCounts }, overall: TranslationCounts }`, where `TranslationCounts` is `{ expected, translated, missing, stale, machine }` (integers). `locales` excludes the source locale. See [server.md](server.md#translation-completeness) for how the counts are computed.

All three objects allow additional properties.

```json
{
  "schemaVersion": 1,
  "releaseId": "release-2",
  "createdAt": "2026-09-04T12:00:00.000Z",
  "collections": {
    "categories": { "hash": "3f1c…", "itemCount": 2, "size": 412 },
    "products":   { "hash": "a9b0…", "itemCount": 42, "size": 18734 }
  },
  "media": {
    "products/tshirt.png": { "hash": "9f8e…", "size": 102450, "mimeType": "image/png" }
  }
}
```

The media file extension is not stored in the manifest. Both server and client derive it from the virtual path (`products/tshirt.png` → `.png`) to build `media/<hash>.png`.

## `collection.json`

The content of `objects/<hash>.json`.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `schemaVersion` | integer, `const 1` | yes | |
| `collection` | string | yes | Collection name |
| `items` | array of `CollectionItem` | yes | |

`CollectionItem`:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes | Unique ID; target of `references` |
| `key` | string | yes | Stable, human-readable lookup key (slug) |
| `translations` | `{ [locale]: { [field]: any } }` | yes | All localized fields live here, grouped by locale |
| `references` | array of `{ collection, id }` | no | Links to items in other collections |
| `media` | array of string | no | Virtual paths into the release's `media` map, used in every locale. Language-specific media goes in `translations[locale].media` instead (see below). |
| `_provenance` | `{ translations?, fields? }` | no | Where values came from (human, machine, ...), see below |
| *any other field* | any | no | Items allow additional properties for non-localized data |

All levels allow additional properties. On items, extra top-level fields hold non-localized data. Field names starting with `_` are reserved for CDS metadata, and only names the schema defines (currently `_provenance`) are CDS fields. The schema validates their shape, so a pass-through field with the same name but the wrong shape fails the publish.

```json
{
  "schemaVersion": 1,
  "collection": "products",
  "items": [
    {
      "id": "prod_tshirt",
      "key": "classic-tshirt",
      "translations": {
        "en": { "title": "Classic T-Shirt", "description": "An everyday essential." },
        "de": { "title": "Klassisches T-Shirt", "description": "Ein Alltags-Klassiker." }
      },
      "references": [{ "collection": "categories", "id": "cat_apparel" }],
      "media": ["products/tshirt.png"]
    }
  ]
}
```

### Provenance (`_provenance`)

Markers record where values came from: `translations` per locale and field, `fields` for non-localized fields (e.g. an AI-detected focal point).

```json
"_provenance": {
  "translations": { "de": { "title": { "status": "machine", "from": "en", "sourceHash": "5f2b…" } } },
  "fields": { "focalPoint": { "status": "machine", "model": "vision-x@2" } }
}
```

| Marker field | Type | Required | Notes |
| --- | --- | --- | --- |
| `status` | `original`, `human`, `machine` or `reviewed` | yes | `reviewed` = machine value checked by a human |
| `from` | string | no | Translations: locale it was translated from (defaults to the release's source locale) |
| `sourceHash` | string | no | Translations: SHA-256 (hex) of the source text at translation time |
| `model` | string | no | Machine values: model/version that produced it |

If the current source text no longer matches `sourceHash`, the translation is **stale** and needs review. Whoever translates or reviews (CMS, adapter) writes the hash of the source text they worked from. The server exports `translationSourceHash(text)` for this. Markers are optional: items without them are still counted for completeness.

### Hashing and serialization

The hash of a collection object is `sha256(deterministicStringify(collection))`, where `deterministicStringify` (`server/src/utils.ts`) emits JSON with object keys sorted recursively and no whitespace. Array order is preserved. The exact serialized string is what gets stored, so the client can verify a download by hashing the bytes it received.

This has two consequences:

- Two publishes of the same content produce the same hash, so unchanged collections are not re-uploaded or re-downloaded.
- Reordering `items` changes the hash. Sources should return items in a stable order.

## Media metadata (`_media` collection, `media-metadata.json`)

Alt texts, descriptions, focal points and sizes of media files are content, kept in the reserved collection `_media`. It's an ordinary collection (stored, hashed and synced like any other), so translation completeness, provenance markers, source map links and target rules apply to it. Each item describes one media file:

```json
{ "id": "rooms/suite.jpg", "key": "rooms/suite.jpg",
  "translations": { "en": { "alt": "Suite with lake view", "description": "Corner suite on the 4th floor…" },
                    "de": { "alt": "Suite mit Seeblick" } },
  "focalPoint": { "x": 0.62, "y": 0.4 },
  "width": 3000, "height": 2000 }
```

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | The media file's virtual path; must exist in the release's `media` map. `key` is the same value. |
| `translations[locale].alt` | string | Short functional text for accessibility (recommended 1–125 characters) |
| `translations[locale].description` | string | Longer text for llms.txt, SEO and JSON-LD (recommended 50–300 characters) |
| `focalPoint` | `{ x, y }`, each `0..1` | The important point of the image, relative to width and height; used when cropping |
| `focalPoints` | `{ [name]: { x, y } }` | Named points of interest (e.g. `lighthouse`, `balloon`), so different crops can center different subjects |
| `width`, `height` | integer ≥ 1 | Intrinsic size in pixels |

`media-metadata.json` validates each `_media` item at publish, in addition to `collection.json`. Media files described twice fail the publish.

### Which media is published

Only **referenced** media is published. A media file is referenced if an item lists it in `media` (all locales) or in `translations[locale].media` (that locale only). The publisher leaves out everything else, together with its `_media` entry, and reports it in `artifacts.content.warnings`. A referenced path the source doesn't provide is reported as well.

### Language-specific media

When an image differs per language (e.g. a diagram with translated labels), each locale references its own file:

```json
{ "id": "home", "key": "home",
  "translations": {
    "en": { "title": "Home",  "media": ["cds-flow.png"] },
    "de": { "title": "Start", "media": ["cds-flow-de.png"] } } }
```

Each file gets its own `_media` entry with texts in **its** language only. CDS derives from the references where an image is used: its alt text and description are expected (translation completeness, recommendations, target rules) only in those locales. An image not used in the source locale isn't a translation at all, so it's left out of completeness.

## `target.json`

Validates target definitions (see [server.md](server.md#targets)). Only `id` (`[a-zA-Z0-9_-]+`) is required. `collections.*.localized`, `collections.*.fields` and `recommendations.*` hold JSON Schemas, which are compiled when the target is checked. Target definitions are pipeline configuration and are never published.

## What the schemas don't check

- `references` are not checked against existing items. `resolveReferences` on the client silently skips dangling ones.
- Strings in an item's `media` array are not checked against the release's `media` map.
- Locale codes are free-form strings. No locale is required, and items in one collection don't have to share the same set of locales.
- Hash strings are not checked for format (length, hex).

## Schema loading

Each package's `validation.ts` looks for the schema files relative to its compiled location (`../../schemas/v1`, `../schemas/v1`, `./schemas/v1`).

- **Server:** throws at import time if a schema file is missing.
- **Client:** falls back to built-in, looser schemas that check only the top-level required fields. This lets the client run from a bundle that doesn't ship the `schemas/` folder, but in that mode item-level and manifest-entry validation is skipped.
