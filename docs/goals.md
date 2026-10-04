# Project Goals

## What CDS solves

An application that reads content straight from a CMS API is tied to that CMS in four ways. It needs the CMS to be reachable at runtime. It sees whatever state the CMS is in, including half-finished edits. It downloads the same unchanged data again and again. And its code is written against that CMS's data model.

CDS removes all four ties. Content is compiled into immutable release snapshots, published as plain files to any file host or CDN, and synced by clients into a local, verified copy that they query without the network.

## Problems and how the code addresses them

Status reflects the code on `dev` as of 2026-10-03.

| # | Problem | How CDS solves it | Where | Status |
| --- | --- | --- | --- | --- |
| 1 | **The app breaks when the network or CMS is down** | The client keeps the active release locally and loads it at startup (`initialize()`) with no network. A failed `sync()` returns an error and leaves the active release untouched. | `client/src/core/client.ts` | Done (Node: filesystem/memory storage) |
| 2 | **Clients see half-published or mixed content** | The server writes objects → release manifest → channel manifest, and only the last step makes a release visible. The client downloads and verifies everything first, then moves one active-release pointer. | `Publisher.publish`, `CDSClient.sync` | Done |
| 3 | **Every update re-sends everything** | Collections and media are stored under their SHA-256 hash. A new release that changes one collection costs one object upload and one object download. Unchanged files are reused by the server and skipped by the client. | `utils.ts` (`deterministicStringify`, `sha256`), sync staging | Done (integration test checks 1 object / 0 media re-fetched) |
| 4 | **Corrupt, truncated or incompatible content reaches the app** | The client hashes every downloaded file against the manifest and validates every manifest and collection against the v1 JSON Schemas. `schemaVersion` is pinned, so a future format is rejected instead of misread. | `validation.ts`, `schemas/v1/` | Done (the client's fallback schemas are looser) |
| 5 | **App code is coupled to one CMS's data model** | All content is normalized into one item shape (`id`, `key`, `translations`, `references`, `media`). CMS specifics live in a `ContentSource` adapter, and storage specifics in `ObjectStore` / `ClientStorage` / `RemoteDownloader`. | `types.ts` interfaces | Interfaces done. Only fixture, filesystem and memory adapters exist. |
| 6 | **Multilingual and related content is awkward to query** | Translations are grouped per locale on every item. The client answers `getLocales()`, `getItemByKey()`, `getItemById()` and `resolveReferences()` from memory. | `CDSClient` query API | Done |
| 7 | **Checking for updates is expensive** | Clients poll one small channel manifest. If it points at the release they already have, sync stops there. The downloader can answer `notModified`. | `CDSClient.sync` steps 1–3 | Done, but the client uses the release ID as its "ETag" rather than a real HTTP ETag |
| 8 | **Different environments need different content** | Channels (`production`, `staging`, ...) are independent pointers to releases in the same store. Promoting or reverting a channel means rewriting one small file. | Channel manifests | Done (retention window is shared across channels, but a channel's current release is never deleted) |
| 9 | **Published storage grows without bound** | The server keeps the last N releases and has a mark-and-sweep GC that deletes objects and media no retained release references. | `Publisher` retention, `analyzeStorage()`, `garbageCollect({ dryRun })` | Server done, with storage report and dry run (GC runs manually). Client prunes manifests only, not objects or media. |
| 10 | **Large collections change by a few records at a time** | Record-level delta files between releases, with full download as fallback. | — | Planned (Milestone 2) |

## Proposed goals (under discussion)

None of these exist in code yet. Each one records the request, the design direction agreed so far, and the open questions. When a proposal is agreed, move it into the table above.

### Decided: CDS reports, it doesn't transform

CDS carries, checks and reports on content. It doesn't change content. Machine translation, AI image processing (focal point, descriptions) and image rendering happen in the CMS or in complementary projects. CDS carries their results with provenance markers and reports what's missing, stale or machine-made.

### Decided: schemas allow additional properties

All v1 schema objects will switch to `additionalProperties: true`, so new optional fields don't break existing clients. Applied in `schemas/v1/` (G1).

### Decided: `_` prefix for CDS fields on items

Items are open objects, so CDS metadata uses the `_` prefix (e.g. `_provenance`). Unlike `$`, it works everywhere: MongoDB, GraphQL, Python attribute access.
- `_` is also used by other systems (`_id`, `_rev`, `_source`, ...). So CDS reserves **specific names**, not the whole prefix. Only the names listed in the collection schema are CDS fields, and the schema validates their shape, so a pass-through `_provenance` with the wrong shape fails the publish instead of being misread.
- Keep the list of reserved names short. Item fields: `_provenance`. Collection names: `_media` (P8).

### P1: Translation completeness (per language and overall)

**Status: implemented in G3** (`artifacts.translations`, `manifest.translations`). Publish gates are left to G4 (targets).

**Problem:** There's no way to see how complete each language is before publishing, or from the client.
**Direction:** The publisher computes completeness while it iterates the collections. Per collection × locale it counts translated, missing and **stale** fields (see P2), then rolls that up per locale and overall. The result goes in the publish result and in the release manifest.
**Open questions:**
- *Decided:* the **source locale is a runtime argument** of the publish run (e.g. `--source-locale en` / `publish(..., { sourceLocale })`). "Expected" fields are the source locale's fields. Without the argument it is detected from the source (adapter, then `_provenance` markers), falling back to `en`.
- *Decided:* an empty (`""`) or `null` translation counts as **missing only if the source locale value is a string longer than zero**. If the source value is empty too, the field isn't expected and isn't counted. Non-string source values (numbers, objects) are ignored.
- *Decided:* gates are target requirements (P7), e.g. "`de` ≥ 100%, 0 stale". An unmet requirement fails the build.

### P2: Auto-translation, provenance and review

**Status: markers, stale detection and the previous-release fallback implemented in G3.** Machine translation runs in the CMS, not in CDS (see "CDS reports, it doesn't transform").

**Problem:** Missing translations should be fillable automatically. Consumers and editors need to know whether text is original, machine-translated or reviewed. And when the original changes, its translations must be flagged for review.
**Direction:** Each translated field records its provenance, plus the hash of the source text it was translated from. The same `_provenance` field also marks non-localized values (e.g. an AI-detected focal point, P9):

```json
"_provenance": {
  "translations": { "de": { "title": { "status": "machine", "from": "en", "sourceHash": "<sha256 of en.title when translated>" } } },
  "fields": { "focalPoint": { "status": "machine", "model": "vision-x@2" } }
}
```

- `status`: `original` | `human` | `machine` | `reviewed`
- **Stale** is computed, not stored: at publish, `sha256(current source value) !== sourceHash` means the original changed after translation and the translation needs review. Reviewing a translation (or re-translating it) writes the current source hash.
- Granularity is per field, because reviewers fix single fields.
- Fallback when the CMS doesn't track source hashes: compare against the previous release. If the source field changed and the translation didn't, flag it as stale.

**Decided:**
- Translation runs in the CMS, where review happens. CDS carries and evaluates the markers.
- `machine` counts as translated in P1, and is also reported separately.
- The marker field is `_provenance` (renamed from `_translation`), so it also covers non-localized fields.

### P3: Optimized media (pre-rendered, imgproxy-compatible)

**Status: moved out of CDS** into the complementary package `@cds/imaging` ([imaging.md](imaging.md)), which runs in the site generator after sync. Optional and early stage; its main idea is fully prerendered sites without runtime dependencies. A live imgproxy service can be added, but needs separate hosting. Following "CDS reports, it doesn't transform", image rendering is not part of CDS core. CDS provides its inputs: original media, focal point and intrinsic size (P8), and the presets/breakpoints declared in targets (P7). The design below is kept as the starting point for that project.
**Open:** how rendered variants come back into a release (e.g. as additional media through a `ContentSource`, with a variant map in the release), and whether CDS reports the required variants per target as a build artifact for the image project to consume.

**Problem:** Clients get original media only. Resized or cropped variants would normally need a live image server.

**Direction: one render function, many places it can run.** Rendering is a pure, deterministic function `render(sourceBytes, options) → bytes` in its own module (sharp-based). The same code runs:
1. **in the publish pipeline** (the primary case: variants are rendered ahead of time and stored in CAS)
2. optionally in a **live server** (on-demand variants)
3. optionally **in a client** that has the original but not the variant it needs (Node clients; browsers would need a wasm/canvas port)

**Who declares what:**
- **Media source:** intrinsic facts: original width/height, focal point (`0..1`) if available, alt text. These live in the `_media` collection (P8).
- **Target:** wanted outputs as **named presets** (e.g. `thumb: 320×320 fill`, `hero: 1920×800 fill`) plus breakpoints, declared in the **target definition** (P7). A preset renders only for the media in its target's scope. Content and layouts refer to preset names, never pixels.
- **Render engine (client):** chooses which variant to load. Browsers do this natively given a `srcset` with widths, so CDS emits the variant set per preset. Native clients use a helper such as `pickVariant(path, preset, { width, dpr })` that returns the smallest variant ≥ the needed size.

**Variant identity and "only render what we need":**
- `variantKey = sha256(sourceHash + canonical options)`. The canonical options include only what affects the output: the focal point is part of the key only for cropping modes (`fill`), not for `fit`. The renderer version should be included if a renderer upgrade must trigger re-rendering.
- The key is known **before** rendering. The release manifest maps `virtualPath → preset → { variantKey, hash, width, height, format }`.
- Before rendering, the pipeline looks up `variantKey` in previous release manifests. If found, it reuses the output hash and skips rendering. No separate render database is needed; the history is the manifests.
- Client demands that aren't covered by a preset can be learned: a client that falls back (3.) reports the missing variant key, and the next publish adds it.

**Serving: file-based contract, optional proxy:**
- The contract stays file-based: every variant is an immutable file at a predictable path, verifiable by hash, and available offline. S3 is just another `ObjectStore` behind the same layout. traefik/nginx/CDN only route and cache.
- A live imgproxy (or the live render server) is an optional **fallback for variants that don't exist**. Its output isn't in any manifest, so clients can't verify it or keep it offline. It needs signed URLs or a preset allow-list, or anyone can request arbitrary sizes.
- "Static if present, else proxy" needs a server that can fall back on 404 (nginx `try_files`, or an S3 404 redirect rule). traefik alone serves static files only via a plugin or a separate file server.

**Open questions:**
- First option set after width/height/focal point/fit: format (webp/avif) and quality?
- Do variants get their own storage prefix (`media/variants/<hash>.<ext>`), or do they share `media/`?

### P4: GC report across releases

**Status: implemented in G2** (`analyzeStorage()`, `garbageCollect({ dryRun })`, channel-pinned retention). Still open: a human-readable formatter, and client-side GC.

**Problem:** GC deletes immediately and returns two counts. Nobody can see what each release costs or what a GC run would free, which matters for large media.
**Direction:** An analysis pass (dry run) that walks the store and reports:
- per release: referenced objects/media/variants, total bytes, and bytes **unique** to that release (what deleting it would free)
- per release vs. the previous one: added, removed and shared files
- channels → current release, so retention never removes a release a channel still points to
- store total, plus orphans (exactly what GC would delete, with sizes)

`garbageCollect({ dryRun })` returns the report, and the real run deletes exactly the listed files.
**Open questions:**
- Object sizes are in neither `CollectionMeta` nor `ObjectStore`. Proposed: add `size` to `CollectionMeta`.
- Output: JSON for CI plus a human-readable formatter?
- Is a client-side equivalent needed? The client doesn't GC objects or media today.

### P5: Schema.org / JSON-LD as a collection

**Status: implemented in G6**, as the reserved collection `_jsonld` (named like `_media`), with publish checks, `jsonld-empty` recommendations and `client.getJsonLd()`. The demo renders it with page and image URLs.

**Problem:** Consumers that want SEO or JSON-LD have to hand-map content to schema.org.
**Decided: CDS carries and checks the JSON-LD data; the site generator renders it.** JSON-LD needs page URLs (`url`, `@id`) and page context, which only the site generator knows. The same applies to llms.txt: it describes a rendered site, so the generator builds it from the pages it rendered, using image descriptions (P8). The demo shows both.

**Direction:** JSON-LD definitions are ordinary content in a dedicated collection (e.g. `jsonld`), linked with the existing `references`. This needs no core schema change, and editors can manage it in the CMS. Example, a hotel location:

```json
{ "id": "ld_hotel", "key": "hotel", "appliesTo": "site_settings",
  "type": "Hotel",
  "values": { "address": { "streetAddress": "Bahnhofstr. 1", "addressLocality": "Bern" },
              "geo": { "latitude": 46.948, "longitude": 7.439 } },
  "map": { "name": "siteTitle" } }
```
- A `jsonld` item holds a schema.org `@type`, a **field mapping** (schema.org property → item field path, e.g. `name ← title`, `image ← media[0]`) and/or **static values** (e.g. publisher organization). Static values can be localized through the item's normal `translations`.
- **Decided: everything JSON-LD lives in the `jsonld` collection, defaults included.** A default is a `jsonld` item that declares `appliesTo: "<collection>"`. Nothing JSON-LD-related goes on other collections.
- **Resolution order** for a content item: its own reference to a `jsonld` item → the `jsonld` item with `appliesTo` = its collection → none.
- A client helper resolves this chain for an item and locale, applies the mapping, and turns references into nested entities. It returns JSON-LD **data without URLs**; the generator adds `url`/`@id` and renders the `<script>` tag.
- Publish check: at most one `appliesTo` per collection. Two fail the build.

**Decided: mapping uses plain field paths, no templates.** Paths can be checked at publish, and templates would transform content. Values that need combining are provided by the CMS (e.g. `fullName`) or combined by the generator.

| Path | Resolves to |
| --- | --- |
| `name` | `translations[locale].name`, else the item's own field `name` (a name in both is reported) |
| `address.city` | Nested field |
| `amenities[0]` | Array element |
| `media[0]` | `ImageObject` from `_media` metadata (caption, description, size) with `"_media": "<virtual path>"`; the generator replaces it with the URL |
| `ref:<collection>` | The referenced item in that collection, rendered with that collection's JSON-LD. **One level deep** by default, so cycles can't occur. |

- `values` (fixed values) can be localized through the `jsonld` item's `translations`.
- Publish checks: invalid path syntax, `ref:` to an unknown collection, or two `appliesTo` for one collection **fail the build**. A path that's empty for some items is a **recommendation** in the content report, unless a target requires the field.

Example result for a `HotelRoom` in `de` (no URLs yet):

```json
{ "@type": "HotelRoom", "name": "Suite mit Seeblick",
  "image": { "@type": "ImageObject", "_media": "rooms/suite.jpg", "caption": "Suite mit Seeblick", "width": 3000, "height": 2000 },
  "containedInPlace": { "@type": "Hotel", "name": "Hotel Bern", "address": { "streetAddress": "Bahnhofstr. 1" } } }
```

### P6: Source map (deep links back to the origin) as a build artifact

**Status: implemented in G2** (`ContentSource.getSourceMap()` → `artifacts.sourceMap`).

**Problem:** Starting from a published item or media file, there's no way to find it in the source system (e.g. to open the CMS editor). That information must not become public.
**Direction (decided): a separate output, not part of the release.** Each publish produces a **source map** as a job artifact: kept by the pipeline (CI artifact, internal storage), never written to the storage root or CDN.

```json
{
  "releaseId": "2026-10-03T12-00-00Z",
  "sources": { "directus": { "baseUrl": "https://cms.example.com" } },
  "collections": {
    "products": {
      "source": { "adapter": "directus", "collection": "products" },
      "items": {
        "prod_tshirt": { "id": "123", "path": "/admin/content/products/123" }
      }
    }
  },
  "media": {
    "products/tshirt.png": { "adapter": "directus", "id": "a1b2-…", "path": "/admin/files/a1b2-…" }
  }
}
```

- Keyed by CDS collection name + item `id` and by media virtual path, so it can be looked up from anything in a release.
- The adapter supplies the references, e.g. through an optional `ContentSource.getSourceMap()` or by attaching them to items in memory. The publisher removes them before hashing, so they never affect hashes or releases.
- Relative `path` + per-source `baseUrl`, so a CMS host move only changes the artifact.
- Content items stay clean: no reserved `_source` field.

**Build artifacts in general:** The source map is the first of several per-publish outputs that are for the pipeline, not for clients. Others would be the completeness report (P1), the GC report (P4), the render log (P3) and target validation results (P7). `publish()` should return a single `artifacts` object that the pipeline stores.

**Open questions:**
- Retention: keep source maps for as long as the release is retained, or longer (audits)?

### P7: Target definitions (requirements per consumer)

**Status: implemented in G4** (`loadTargets`, `resolveTargets`, `publish({ targets })`, client `target` option). `media` presets are merged and exported in `artifacts.targets` for the image project.

**Problem:** A release is built for consumers that have concrete expectations, but nothing states or checks them. For example:
- a kiosk must have the `contact_info` item `emergency`, or it can't show emergency contacts
- a hotel website needs a `rooms` collection whose items have `name`, `description` and an `amenities` object
- each consumer has its own screen sizes, so it needs different image variants (rendered by the image project, P3)

Today a release that breaks these expectations publishes and syncs without complaint.

**Direction:** A **target definition** is a declarative contract between one consumer and the content. A job run takes a **default target** plus **0–n named targets** and produces exactly **one dist output** (one release). Targets don't produce separate outputs. They decide which checks the dist must pass, and declare the image presets the image project (P3) renders.

A target can declare:

| Section | Purpose | Ties to |
| --- | --- | --- |
| `locales` | Required locales, minimum completeness, max stale | P1, P2 |
| `collections` | Required collections, with an expected item schema (JSON Schema for localized fields and for top-level fields), `minItems` | |
| `items` | Required named items (`collection` + `key`) | |
| `scope` | The subset of collections (later perhaps a filter) the target applies to. Image presets apply **only to media referenced by items in scope**. | P3 |
| `media` | Breakpoints, DPR, named presets (aspect, fit/fill, format, quality): the contract for the image project | P3 |
| `recommendations` | Like `collections`, but only reported, never failing (e.g. text lengths) | P10 |

Sketch:

```json
{
  "id": "hotel-web",
  "locales": { "required": ["en", "de"], "minCompleteness": 1.0, "maxStale": 0 },
  "scope": ["rooms", "site_settings", "jsonld"],
  "collections": {
    "rooms": {
      "minItems": 1,
      "localized": {
        "type": "object",
        "required": ["name", "description"],
        "properties": { "name": { "type": "string" }, "description": { "type": "string" } }
      },
      "fields": {
        "type": "object",
        "required": ["amenities"],
        "properties": { "amenities": { "type": "object" } }
      },
      "presets": ["card", "hero"]
    }
  },
  "items": [{ "collection": "site_settings", "key": "homepage" }],
  "media": {
    "breakpoints": [480, 768, 1280, 1920],
    "dpr": [1, 2],
    "presets": {
      "card": { "aspect": "4:3", "fit": "fill" },
      "hero": { "aspect": "21:9", "fit": "fill" }
    }
  }
}
```

**Where requirements are enforced:**
1. **At publish:** an unmet requirement **fails the build**. Recommendations (P10) are only reported. Results go into the build artifacts (P6).
2. **At client sync (optional):** the release manifest records which targets it satisfies. Variants from all targets go into the release's **single** media/variant map (keyed by virtual path → preset), so a preset name must mean the same thing in every target (see merge rules below). A client configured as `hotel-web` refuses to activate a release that doesn't satisfy `hotel-web`, **or doesn't list it at all**, and keeps the last good one. That's goal #2 (no broken content) extended to *semantically* broken content.

**Decided:**
- **Default target:** always present, and applies to **everything** (all collections). It may define requirements and presets, but it doesn't have to define any image resolutions. When no named targets exist, it is the only target. **If no default target is provided, CDS uses built-in fixed defaults** (including the default recommendations, P10).
- **Loading:** `targets/*.json` (`default.json` = default target), with the folder passed as a runtime argument of the publish job. Definitions can also be passed in code.
- **Required translated fields:** a target's item schema decides which localized fields are required per locale. Completeness (P1) only feeds the thresholds (`minCompleteness`, `maxStale`), so a gap is reported once.
- **Named targets merge with the default.** The effective definition of a named target is the default plus the named target's own declarations.
- **Scope is the exception to merging.** A named target's `scope` limits only its **own** presets and requirements. Inheriting the default's "everything" would cancel out subset rendering. Default presets still apply to all media.
- **Location:** versioned files next to the pipeline config (e.g. `targets/*.json`), owned by the consumer's team, validated by a new `schemas/v1/target.json`. Not CMS content.
- **Targets and channels are independent.** Channels only point at releases. Which targets a release satisfies is recorded in the release itself.
- **Merging is additive only. Nothing is overwritten or replaced.** Lists (`locales.required`, `items`, breakpoints, DPR, presets, required collections) are combined. Requirements accumulate, so a named target can add or tighten but never loosen: for a threshold declared twice (e.g. `minCompleteness`), both apply and the stricter one wins. Item schemas declared by several targets are combined with `allOf` (all must pass), which is additive. A **preset** defined differently under the same name is a conflict and fails the build, because all variants share one release. Identical definitions are fine and are rendered once.
- **Number of targets:** no hard cap. The recommended maximum is **8**.

**Image cost (for the image project):** Variants from different targets with the same source and options get the same variant key, so they're rendered and stored once (P3). Cost grows with *media in scope × presets × widths*, not with the number of targets.

**Open questions:**
- *Decided:* breakpoints are named (`name → minimum screen width`), and each preset lists an **explicit width per breakpoint**; rendered pixels = width × DPR. Breakpoint names are shared across targets (a different value fails the build).

### P8: Media metadata as content (`_media` collection)

**Status: implemented in G5** (`media-metadata.json`, publish checks, `getMediaInfo()`, demo hero image). Also decided and implemented: only referenced media is published (the rest is reported); language-specific media is referenced per locale (`translations[locale].media`), and its texts are expected only there; named `focalPoints` for several crops of one image; an optional `name` for readable output file names (default: the original file name), and a content report recommendation for meaningless file names.

**Problem:** Images have no alt text, description, focal point or intrinsic size. Accessibility, llms.txt, JSON-LD and image rendering all need them.
**Decided:** Media metadata is content, in a reserved collection `_media`, one item per media file keyed by its virtual path:

```json
{ "id": "rooms/suite.jpg", "key": "rooms/suite.jpg",
  "translations": { "en": { "alt": "Suite with lake view", "description": "Corner suite on the 4th floor…" },
                    "de": { "alt": "Suite mit Seeblick" } },
  "focalPoint": { "x": 0.62, "y": 0.4 },
  "width": 3000, "height": 2000 }
```

- `alt`: short functional text for accessibility. `description`: longer text for llms.txt, SEO and JSON-LD `image.description`. Both are localized.
- `focalPoint` (`0..1`) and intrinsic `width`/`height` are non-localized fields. The media source declares them.
- Because it's an ordinary collection, completeness and stale detection (P1/P2), provenance markers, source map links (P6) and target requirements (P7) apply without extra code.
- Not in the release manifest's `media` entries, so texts in every language don't bloat the manifest clients poll.

### P9: AI processing of media (focal point, descriptions)

**Problem:** Focal points and descriptions are tedious to enter by hand for many images.
**Decided: runs in the CMS, not in CDS** (e.g. a Directus flow on upload). The CMS writes the values together with a provenance marker (`status: "machine"`, `model`), and editors review them where they already work. CDS carries the markers, counts machine-made values and reports them (P10). An image-processing service could be part of the complementary image project (P3).

### P10: Content report with recommendations

**Status: implemented in G4** (`artifacts.content`, built-in `_media` recommendations). `createPublishReport` / `renderPublishReportHtml` turn it into `report.json` + `index.html` for editors and CI.

**Problem:** Editors don't know what's missing or below standard (missing alt text, descriptions that are too short or too long).
**Direction:** A **content report** in the build artifacts, extending the G3 issue list. Each issue carries its severity, the recommendation and a source map link (P6) back to the CMS record:

```json
{ "collection": "_media", "id": "rooms/suite.jpg", "locale": "de", "field": "description",
  "issue": "missing", "severity": "recommendation", "recommended": "50–300 characters",
  "source": "https://cms.example.com/admin/files/7f3a" }
```

- **Severities:** `requirement` (from targets, fails the build) and `recommendation` (reported only).
- **Recommendations** use the same JSON Schema keywords as requirements (`required`, `minLength`, `maxLength`), so a target turns one into a hard rule by declaring it as a requirement.
- **Built-in defaults** (used when no default target is provided): `_media` `alt` 1–125 characters, `description` 50–300 characters. More defaults are added as needed.

### P11: Routes, pages and blocks

**Status: implemented in G7** (schemas, publish checks, recommendations, `getRoutes`, `getAlternates`, `resolveRoute`, `getPage`). Block `links` are validated with menus in G8.

**Problem:** CDS carries content but not site structure. Which URLs exist, which page each one shows, and what a page is made of all live in generator code today. In the demo, 7 section headings, the language switcher, the output file names and two links are hard-coded in `build-demo.ts`.

**Direction:** Three **optional, typed** reserved collections (named like `_media` and `_jsonld`): a site can use all, some or none of them. CDS validates each against its schema only when it's present. Like everything in CDS, they only describe structure; rendering stays with the generator or client.

```
_routes  ──page──▶  _pages  ──blocks[]──▶  _blocks  ──items[]──▶  any collection item(s)
(URL per locale)   (title, SEO)          (type, texts, links)     (features, rooms, _media, …)
```

**`_routes`**: one item per URL. The path is localized, so each language can have its own slug, and the same route in other languages gives the `hreflang` alternates and the language switcher.

```json
{ "id": "r_home", "key": "home", "page": "p_home",
  "translations": { "en": { "path": "/" }, "de": { "path": "/de/" } } }
```

- Optional `redirect` (another route id) with `status` (301/302) instead of `page`.
- **Static routes are the default**: every route is listed in `_routes`, which suits fully prerendered sites. *Dynamic routes* for server-side rendering (patterns such as `/rooms/{key}` resolved at request time) stay open until there's a use case to demonstrate.

**`_pages`**: page metadata and the ordered list of blocks.

```json
{ "id": "p_home", "key": "home", "blocks": ["b_hero", "b_how", "b_flow", "b_features", "b_goals"],
  "translations": { "en": { "title": "CDS – Content Distribution System", "description": "…" }, "de": { … } } }
```

**`_blocks`**: one section of a page. `type` tells the generator how to render it (CDS doesn't interpret it). Block texts (heading, intro, link labels) are localized like any content, so they're counted for translation completeness.

```json
{ "id": "b_features", "key": "features", "type": "card-grid",
  "source": { "collection": "features" },
  "translations": { "en": { "title": "Core Capabilities", "intro": "…" }, "de": { "title": "Kernfunktionen", "intro": "…" } } }

{ "id": "b_hero", "key": "hero", "type": "hero",
  "items": [{ "collection": "site_settings", "id": "settings_main" }],
  "media": ["hero.svg"],
  "links": ["l_explore", "l_github"] }
```

- **Items**: either explicit, ordered `items` (`{ collection, id }`), or `source: { collection }` for **the full collection**, in its order. No sorting, limits or filters in CDS: the content source delivers collections the way they should appear. A block with neither is a *generator block* (e.g. the demo's release log).
- **Media**: `media` / `translations[locale].media`, the same rules as for items (so the language-specific diagram works unchanged).
- **Anchor**: the block's `key` is its anchor (`#features`), so links can point to a block on a page.
- **Links**: shared link items (see P12).

**Checks at publish (build fails):** a route without a page or redirect, a redirect cycle, the same path twice in one locale, references to unknown pages, blocks, items or collections. **Recommendations:** pages without a route, blocks no page uses, missing page title/description, a locale with a page but no path.

**Client:** `resolveRoute(path)` → route, locale, page and blocks with their items resolved; `getRoutes()` for static generation and a sitemap; `getAlternates(routeId)` for `hreflang` and the language switcher.

**Ties in:** JSON-LD per page (a `WebPage` definition via `appliesTo: "_pages"`), llms.txt per route, sitemap.xml from routes, and targets can require routes (e.g. a kiosk needs `/emergency`).

### P12: Menus (nestable link items)

**Demo:** G9 moved the demo onto routes, pages, blocks and menus, with a static and a Hono (SSR) mode.

**Status: implemented in G8** (`menu.json`, publish checks, `missing-label`, `getMenu`, `resolveLink`).

**Problem:** navigation is hard-coded in generators.

**Direction:** a reserved collection `_menu` of link items. A root item is a menu (`key: "main"`, `"footer"`); `children` lists its entries in order, and entries can have children of their own.

```json
{ "id": "m_main", "key": "main", "children": ["l_how", "l_features", "l_github"], "translations": { "en": {} } }
{ "id": "l_features", "key": "features", "link": { "route": "r_home", "block": "b_features" },
  "translations": { "en": { "label": "Features" }, "de": { "label": "Funktionen" } } }
{ "id": "l_github", "key": "github", "link": { "url": "https://github.com/…" },
  "translations": { "en": { "label": "GitHub" }, "de": { "label": "GitHub" } } }
```

- **Link targets:** `route` (resolved to the localized path), optionally with `block` (anchor), or an external `url`. The same link shape is used by blocks (hero buttons), so menus and blocks share one link model.
- **Per locale:** labels are translated content. An entry without a label in a locale is hidden there and reported.
- **Checks:** no cycles, link targets exist, a maximum depth (e.g. 3); external URLs must be absolute.
- **Client:** `getMenu(key, locale)` → a tree of `{ label, href, children }` with resolved hrefs.

### Decided: frontends read CDS, not the backend's API

CDS is the data contract between a backend and a frontend: either side can be replaced without touching the other. A frontend therefore reads CDS collections (`getCollection`, `_routes`, `_pages`, `_menu`, …), not the backend's query language.

The Directus compat layer in `@cds/directus` (Directus REST semantics answered from a release) does the opposite: the frontend keeps thinking in Directus. It is a **migration aid** for existing Directus frontends, proven on hotelplatform.io. It is not the target integration.

### P13: Editing in the frontend, through the source adapter

**Status: decided direction, not implemented.**

**Problem:** editors want to fix wording where they see it: on the page, in a preview mode. If the frontend writes to the backend directly (as Directus' Visual Editor does), the frontend is tied to that backend again, which defeats the contract.

**Decided:**
- **Edits never go into CDS.** Releases stay immutable, CDS stores no edits, and the backend stays the only source of truth. Writing into a release or keeping edits in CDS is the anti-pattern.
- **Editing belongs to the content source adapter.** Every adapter must do the read side (backend → CDS). Preview support and editing in the preview are **always optional**: an adapter may offer the write side (an edit addressed in CDS terms → the backend's own update), and one without it simply means "no editable preview for this backend".

```
read:  backend ──adapter.read──▶ release ──▶ frontend
edit:  frontend ──{ collection, item, field, locale, value, basedOn }──▶ adapter.write ──▶ backend
```

**What it takes:**
- **Field-level addressing.** The frontend only knows CDS addresses (`pages/home/title/en`) and marks editable text with them in preview (e.g. `data-cds="…"`). The adapter maps an address to its source: collection, record, field (for Directus: `pages` item 12, field `title`, or a translation row). This extends the source map (P6) from items to fields.
- **Only 1:1 fields are editable.** The adapter tells which fields map 1:1 to a source field and which are derived (joined, computed, converted from Markdown, taken from another record). Derived fields aren't editable in place.
- **Conflicts.** An edit carries the source version it was based on (`basedOn`; for Directus `date_updated`). The adapter refuses it when the record changed in the meantime.
- **Permissions.** The write runs with the editor's own credentials, and the backend enforces its own permissions. CDS holds no write credentials and does no authentication.
- **Translations.** An edit targets one locale. Editing a machine translation marks it human-made in `_provenance` (P2).
- **Showing the result.** The preview client lays unpublished edits over the release (an overlay, preview only) until the next publish includes them.

**Open:**
- The adapter interface: the shape of `write`, how an adapter declares which fields are editable, and the error and conflict results.
- Rich text: what the editor sends and how the adapter converts it to the backend's format.
- Where the editing UI lives (likely a companion package, like `@cds/imaging`).
- How the preview obtains the editor's credentials for the backend.

### Verification against the demo

The demo page mapped onto P11/P12:

| Demo section | Block | Items / data | Today |
| --- | --- | --- | --- |
| Hero | `hero` | `site_settings/homepage`, media `hero.svg`, links "Explore goals", "GitHub" | links hard-coded |
| How CDS works | `steps` | block texts (3 steps) | **hard-coded** |
| How a release travels | `image` | localized media `cds-flow.png` / `cds-flow-de.png` | works as is |
| Core capabilities | `card-grid` | `source: features` | heading **hard-coded** |
| Design principles | `icon-list` | `source: goals` | heading **hard-coded** |
| One image, three crops | `image-crops` | `_media/coast…`, crop settings | note **hard-coded** |
| Image variants and costs | `image-report` | none (generator block) | **hard-coded** |
| Testimonials | `quotes` | `source: testimonials` | heading **hard-coded** |
| Release log | `release-log` | none (generator block) | **hard-coded** |
| Footer, language switcher | layout | `site_settings`, route alternates | switcher **hard-coded** |

Routes: `r_home` with `/` (en) and `/de/` (de) replaces the hard-coded `index.html` / `index-de.html`. Menu: a `main` menu with anchor links to the blocks and the GitHub link.

**Findings:**
- The model covers every section. Moving headings and intros into block texts removes all `locale === "en" ? … : …` strings from the generator, and translation completeness then covers them.
- Generator blocks (no items) are needed for output the generator computes (release log, image costs).
- Block presentation settings (e.g. the crop zoom per image) need a place: a free `settings` object on the block, which CDS doesn't interpret.
- Links need anchors to blocks (`#goals`), so block keys double as anchor ids.
- The demo has a single page, so it doesn't exercise several routes, redirects or nested menus. Verifying those needs a second page.

**Decided:**
- `_routes`, `_pages` and `_blocks` are separate, optional, typed collections; blocks are reusable across pages.
- Paths are set per language (`/de/zimmer`).
- `source` always takes the full collection; no sort, limit or filter.
- Menus nest via `children` on the parent (P12).
- Static routes are the default (prerendered sites). Dynamic routing for SSR stays open until a use case can be demonstrated.
- *Update:* the demo's Hono mode demonstrates the SSR use case with the same static routes: paths are resolved per request (`resolveRoute`), and a newly synced release is live without a rebuild. Route *patterns* (e.g. `/rooms/{key}`) are still open.

## Principles

- **The core is content-agnostic.** Hashing, manifests and sync treat collections as generic records and never interpret fields.
- **Adapters adapt, the schema doesn't bend.** If a CMS lacks a feature (e.g. per-field translations), its source adapter maps or emulates it into the standard item shape.
- **Only the channel pointer changes.** Releases, objects and media are written once, so a CDN can cache them indefinitely.
- **Verify, then activate.** The client never activates content it hasn't hashed and validated.
- **Report, don't transform.** CDS checks content and reports problems back to the content source. Translation, AI processing and image rendering happen in the CMS or in complementary projects.

## Non-goals

- **Not a CMS.** CDS doesn't author or edit content.
- **Not a renderer.** Turning content into UI, JSON-LD script tags or llms.txt is the site generator's job. The demo shows one way.
- **Not a transformer.** No machine translation, AI processing or image rendering inside CDS.
- **Not a live query API.** Clients query a local snapshot. Edits become visible only through a new release.
- **No semantics in the core.** Routing, page layouts and SEO metadata are meant as optional specs layered on top (root README, "Tier 2"), not as part of the core schema.

## Milestones

**Milestone 1: core protocol (done).** v1 schemas, publisher with filesystem store and fixture source, client with memory and filesystem storage, and an end-to-end test covering CAS reuse, atomic activation, retention and GC.

**Milestone 2: delta sync (not started).** Delta manifest spec, publisher computing deltas against a previous release, client applying them with full-download fallback.

### Open gaps against the goals

Needed before the table above is fully "done"; [implementation-plan.md](implementation-plan.md) groups them as G10–G13:

- Production adapters: S3-compatible `ObjectStore`, Directus `ContentSource`, HTTP `RemoteDownloader`, IndexedDB `ClientStorage` (#1, #5)
- Browser-compatible hashing (WebCrypto) in the client (#1, #4)
- Real HTTP ETag handling in `sync()` (#7)
- Client rollback API and client-side object/media GC (#9)

The Tier 2 specs from the root README (routing, layout tree, SEO metadata) are covered by P11 (routes, pages, blocks), P12 (menus) and P5 (JSON-LD).
