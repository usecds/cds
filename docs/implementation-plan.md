# Implementation Plan

The proposals in [goals.md](goals.md#proposed-goals-under-discussion) were split into groups that could be built, tested and merged one at a time, each leaving the system working. Each group shipped with tests and doc updates (`docs/*.md`, status in `goals.md`). All groups below are on `dev`.

Guiding rule: **CDS reports, it doesn't transform.** Machine translation and AI processing run in the CMS; image rendering lives in the complementary package `@cds/imaging`.

```
G1 Foundation ─▶ G2 Artifacts & GC ─▶ G3 Translations ─▶ G4 Targets & report ─▶ G5 Media metadata ─▶ G6 JSON-LD
                                                                                          │
G7 Routes, pages, blocks ─▶ G8 Menus ─▶ G9 Demo on the site structure (static + Hono) ◀──┘
                                       + @cds/imaging, publish report, llms.txt (alongside)
```

## Done

| Group | Contents | Commit |
| --- | --- | --- |
| G1 Foundation | Extensible v1 schemas (`additionalProperties: true`), required `CollectionMeta.size`, `publish()` returns `{ manifest, artifacts }` | `7b1787b` |
| G2 Artifacts & GC (P6, P4) | Source map artifact, `analyzeStorage()`, `garbageCollect({ dryRun })`, channel-pinned retention | `3ab2c54` |
| G3 Translations (P1, P2) | `_provenance` markers, source locale resolution, completeness and stale detection, manifest summary, client helpers | `ab3a731`, `02a8415` |
| G4 Targets & content report (P7, P10) | Target files, additive merge, requirements (fail the build) and recommendations, content report, client `target` option | `dbfec69` |
| G5 Media metadata (P8) | `_media` collection, only referenced media published, language-specific media, named focal points, readable names, meaningless-name recommendations | `c707d15`, `3ac5af3`, `f2385f0` |
| G6 JSON-LD (P5) | `_jsonld` collection with plain field paths, publish checks, `jsonld-empty` recommendations, `client.getJsonLd()` | `8a99a93` |
| G7 Routes, pages, blocks (P11) | Optional typed `_routes`, `_pages`, `_blocks`; checks and recommendations; `getRoutes`, `getAlternates`, `resolveRoute`, `getPage` | `2b05f9d` |
| G8 Menus (P12) | Optional typed `_menu`, nestable link items shared with blocks; `getMenu`, `resolveLink` | `be4b111` |
| G9 Demo on the site structure | All structure as content; static mode (files per route) and Hono mode (routes resolved per request, live re-sync) | `31d0a60`, `5d0b65b` |

**Alongside the groups:**
- **`@cds/imaging`** (P3, complementary): crops by focal point and zoom, sizes per breakpoint, formats ordered by measured size, readable file names, SVG pass-through, and a `VariantCache` that renders on request (`feat` commits `528d851` … `6f262fc`).
- **Publish report** (`report.json` + `index.html`) for editors and CI (`24a66cb`).
- **llms.txt** generated from the rendered pages, with image descriptions (`d59193a`).

## Next (proposed)

### G10: Real content source and transport (largely done, on `feat/directus-adapter`)

The first end-to-end run against real systems.
- Done: **`@cds/directus`** with `DirectusSource` (GET only; records, referenced files, `_media`, source map), the `cds-directus-publish` CLI, and `createDirectusCompat`, a Directus-compatible read API over a synced client. Proven on hotelplatform.io: identical rendered pages with CDS in between ([directus.md](directus.md)).
- Done: `HttpDownloader` and `FilesystemDownloader` in `@cds/client`.
- Done: mapped publishing (a site mapping turns records into the CDS contract) and editing (P13): field-level source map, `SourceEditor` / `DirectusEditor`, the client's `EditOverlay`, `sourceReadAt` on releases. hotelplatform.io reads CDS natively and has an editable preview.
- Open: real ETag handling in `sync()` (`If-None-Match`, `304`) end to end; publishing from a Directus flow or webhook instead of a manual CLI run.

### G11: S3 object store

An `ObjectStore` for S3-compatible storage (AWS, R2, MinIO), with cache headers (`immutable` for objects, media and releases; short for channels) and upload skipping for content that already exists.

### G12: Browser client

`@cds/client` in the browser: `IndexedDB` storage, WebCrypto hashing, no Node APIs.

### G13: Smaller open items

- Cleanup of stale variants in an image cache (`VariantCache` only grows)
- Client rollback API and client-side cleanup of unreferenced objects and media
- Route patterns for dynamic routing (`/rooms/{key}`), now that the Hono mode gives a use case
- Whether rendered image variants should go into releases (verified, available offline on clients)

### Milestone 2: Delta sync

Record-level deltas between releases, with full download as fallback. See [goals.md](goals.md#milestones).

## Not in CDS

- **Image rendering:** `@cds/imaging`, used by site generators (see [imaging.md](imaging.md)).
- **Machine translation and AI processing** (P2, P9): run in the CMS. CDS carries `_provenance` markers and reports.
