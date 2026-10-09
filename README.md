# Content Decoupling System (CDS)

CDS gives a frontend the content of a CMS backend without the two ever talking to each other directly. A frontend built on CDS works with any backend that supports CDS, and the data contract between them is deliberately loose.

> **Early stage.** Milestone 1 is implemented: publishing, sync and verification, the filesystem store, Node storage (filesystem, memory) and the Directus adapter. The client runs in Node only, not yet in browsers. APIs and the schema may change before 1.0. Items marked *planned* or *in discussion* don't exist yet; [docs/goals.md](docs/goals.md) has the current status of every goal.

Rather than querying a CMS directly over a live, unreliable API, CDS normalizes CMS content into static, version-controlled, content-addressed JSON collections and media assets. These assets are compiled into immutable releases and published as plain files (the filesystem store today; an S3 store is *planned*), so any file host or CDN can serve them. Client applications use a lightweight CDS client library to pull, locally cache, and atomically consume content, so they keep working offline and query content locally without the network.

```
+------------+     Publish     +------------+     Sync/Push     +------------------------+
|  CMS (e.g. | --------------> | CDS Server | ----------------> |  Object Store / CDN    |
| Directus)  |                 +------------+                   |                        |
+------------+                 (Normalizes,                     | - channels/<name>/     |
                                Version-controls,                |   manifest.json        |
                                Content-addresses)               | - releases/<id>.json   |
                                                                | - objects/<hash>.json  |
                                                                | - media/<hash>.<ext>   |
                                                                +------------------------+
                                                                            |
                                                                            | (Download missing)
                                                                            v
+------------------+           Query API            +------------+     Lightweight Sync
|   Client App     | <----------------------------- | CDS Client | <-------------------------+
| (Kiosk, TV, Web) |                                +------------+
+------------------+                                (FS / memory)   
```

---

## Key Design Principles & Goals

- **CMS & Platform Independence:** Maintain strict isolation. Neither the CMS (e.g., Directus) nor the storage provider (e.g., S3) should leak into the CDS schema or public client protocol.
- **Content-Addressed Storage (CAS):** Unchanged JSON collections or media assets are stored by their SHA-256 hash. If multiple releases contain identical data, they reference the same object file, eliminating duplicate storage and reducing bandwidth during syncs.
- **Offline Resilience:** The client maintains a complete, valid local snapshot of the active release. If connectivity is lost or an update fails, the app continues running instantly.
- **Atomic Activation:** Clients stage downloaded releases completely in a temporary background buffer before performing a swift, atomic switchover. They never experience a half-updated state.
- **Channel-Driven Updates:** Clients periodically monitor a tiny `channels/<channel-name>/manifest.json` file using HTTP ETags. This manifest specifies the active `releaseId`, permitting near-instant update detection.
- **Rollback and Retention:** The server retains a configurable history of recent or channel-pinned releases. A client-side rollback API to revert to an earlier local snapshot is *planned*.
- **Safe Garbage Collection:** `garbageCollect()` on the server deletes object and media files that no retained release references, with a dry run to preview it. Client-side GC is *planned*.
- **Delta/Diff Synchronization (*planned*, Milestone 2):** Would support record-level incremental delta streams for high-volume content, transmitting only modified or deleted records between release versions, with seamless full-download fallbacks.

---

## CDS Protocol & Storage Structure

The distribution target (the local filesystem today; S3 *planned*) follows a strict, predictable flat directory layout:

```
<storage-root>/
├── channels/
│   └── <channel-name>/
│       └── manifest.json          # Points to the active releaseId
├── releases/
│   └── <release-id>.json          # Lists collections, objects, and media mappings
├── objects/
│   └── <sha256-hash>.json         # Content-addressed JSON collection objects
└── media/
    └── <sha256-hash>.<extension>  # Content-addressed raw binary assets (images, videos, etc.)
```

### 1. Channel Manifest (`channels/<channel>/manifest.json`)
A tiny JSON payload mapped to a release identifier. This is the only dynamic entrypoint clients fetch.

```json
{
  "schemaVersion": 1,
  "channel": "production",
  "releaseId": "2026-09-04T12-00-00Z",
  "updatedAt": "2026-09-04T12:00:00.000Z"
}
```

### 2. Release Manifest (`releases/<release-id>.json`)
Declares the full structure of a given release, referencing content-addressed objects and mapping virtual media file paths to their hashes.

```json
{
  "schemaVersion": 1,
  "releaseId": "2026-09-04T12-00-00Z",
  "createdAt": "2026-09-04T12:00:00.000Z",
  "collections": {
    "products": {
      "hash": "a1b2c3d4...",
      "itemCount": 42
    },
    "pages": {
      "hash": "e5f6g7h8...",
      "itemCount": 10
    }
  },
  "media": {
    "banners/hero.png": {
      "hash": "9f8e7d6c...",
      "size": 102450,
      "mimeType": "image/png"
    }
  }
}
```

### 3. Collection Object (`objects/<sha256>.json`)
Collections represent arrays of normalized content entries. Each entry has a unique `id` and a stable string `key`.

```json
{
  "schemaVersion": 1,
  "collection": "products",
  "items": [
    {
      "id": "prod_001",
      "key": "classic-tshirt",
      "translations": {
        "en": {
          "title": "Classic T-Shirt",
          "description": "An everyday essential."
        },
        "de": {
          "title": "Klassisches T-Shirt",
          "description": "Ein Alltags-Klassiker."
        }
      },
      "references": [
        { "collection": "categories", "id": "cat_apparel" }
      ],
      "media": [
        "banners/hero.png"
      ]
    }
  ]
}
```

---

## Architectural Layout: Core, Specs, Adapters & Custom Mappers

To achieve both **absolute operational stability** and **unlimited schema flexibility**, the CDS architecture is structured into three decoupled layers:

```
┌────────────────────────────────────────────────────────────────────────┐
│               Tier 3: ADAPTERS, BRIDGES & CUSTOM MAPPERS               │
│  Translates arbitrary CMS models ➔ Custom Mapper ➔ Standard CDS JSON   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Outputs valid CDS Collections
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│              Tier 2: SEMANTIC SPECS & BEST PRACTICES                   │
│  (Optional specs for routing.json, block layouts, Schema.org SEO, etc) │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Complies with Core schemas
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        Tier 1: CDS CORE (As-Is)                        │
│   (Content-agnostic Transport: CAS, Release Manifests, Atomic Sync)   │
└────────────────────────────────────────────────────────────────────────┘
```

### 1. Tier 1: CDS Core (The Transport Engine)
The core library operates completely blind to what the content represents. It is 100% content-agnostic, treating collections as flat, generic JSON records. Its only duties are:
*   Enforcing SHA-256 CAS content integrity.
*   Resolving, staging, and executing atomic release updates.
*   Pruning old releases and garbage-collecting orphaned files in the store.

### 2. Tier 2: Specifications & Best Practices (The Semantics)
While the Core does not care about fields, CDS defines optional reserved collections for common client-side concerns. They are validated only when present (see [docs/schemas.md](docs/schemas.md)):
*   **Site structure (`_routes`, `_pages`, `_blocks`, `_menu`):** URLs per language, page metadata, ordered blocks and nestable menus, so clients can render pages without knowing the CMS.
*   **Site settings (`_site`, `_languages`):** the site's name per language, its default language and the languages it is published in.
*   **Media metadata (`_media`):** alt texts, descriptions, focal points and readable names per language.
*   **Schema.org definitions (`_jsonld`):** how items map to JSON-LD, resolved by the client with `getJsonLd()`.

### 3. Tier 3: Adapters & Custom Mappers (The Bridge)
This tier connects specific content sources to client targets (web, TV apps, kiosks). The Directus adapter (`@usecds/directus`) exists today; adapters for other CMSs such as Strapi or headless WordPress are *in discussion*.

To guarantee end-to-end compatibility, Tier 3 introduces **Custom Mappers**:

```
[ Raw CMS Entry ] ──> [ CUSTOM MAPPER (Configurable Translation) ] ──> [ Valid CDS Collection ]
```

*   **Role of Custom Mappers:** CMS instances are highly customized, containing business-specific field namings (e.g. `product_price_usd`, `main_photo_url`). A **Custom Mapper** is a configurable function or map schema running on the CDS Server. It ingests arbitrary CMS exports, translates, and normalizes them into the structured formats expected by the client and the CDS Core.
*   **Fallback Emulation Law:** If a CMS or client runtime lacks a native feature (such as multilingual fields, relation indexing, or relational databases), the **Adapter/Mapper must emulate the feature (X)**. For example, if a legacy CMS only supports one language per field, the source mapper merges separate `_en` and `_de` suffix entries into a single multilingual CDS schema record.

---

## Client Synchronization Algorithm

The TypeScript CDS client utilizes the following workflow during synchronization:

1. **Check Channel:** Query `channels/<channel>/manifest.json`. Use `If-None-Match` with the cached ETag. If a `304 Not Modified` is returned, stop.
2. **Assess Compatibility:** Check `schemaVersion` in the manifest. If incompatible, log an error (requires client library upgrade).
3. **Compare Release ID:** If the target `releaseId` matches the currently active local release, stop.
4. **Fetch Release Manifest:** Download `releases/<releaseId>.json`.
5. **Identify Missing Assets:** Compare the hashes in `collections` and `media` against local storage (filesystem or memory; IndexedDB *planned*). Compile a queue of only new/missing hashes.
6. **Staged Download:** Download missing `.json` objects and media assets into a temporary staging layer. Verify the SHA-256 hash of each file during download.
7. **Atomic Switch:** Once 100% of the files are validated, update the client pointer pointing to the active `releaseId`.
8. **Pruning (*planned*):** Remove local files belonging to older releases that exceed the local retention quota.

---

## Repository Structure (TypeScript Monorepo)

```
cds/
├── package.json               # pnpm workspace scripts (test, build, demo)
├── schemas/v1/                # JSON Schemas: the wire format and source of truth
├── server/                    # @usecds/server: Publisher, reports, FixtureSource, FilesystemStore
├── client/                    # @usecds/client: CDSClient, MemoryStorage, FilesystemStorage, HTTP downloader
├── directus/                  # @usecds/directus: Directus source, publish CLI, optional editor
├── imaging/                   # @usecds/imaging: complementary image processor (not CDS core)
├── demo/                      # EN/DE demo site built from a synced release (static or Hono)
├── tests/                     # Vitest suites, including the end-to-end lifecycle test
└── docs/                      # Goals, server, client, schemas, Directus, imaging, demo
```

---

## Development Roadmap (Milestone 1)

1. [x] Establish the TypeScript monorepo configuration (`pnpm` / workspaces).
2. [x] Define Version 1 JSON schemas for channel manifests, release manifests, and collections.
3. [x] Implement core Server logic + Local Filesystem and Fixture adapters.
4. [x] Build the core Client SDK + In-Memory and Local Filesystem adapters.
5. [x] Write end-to-end integration tests confirming:
    - [x] Successful publication and CAS reuse of identical assets.
    - [x] Robust offline fallback and atomic activation.
    - [x] Garbage collection of obsolete, unreferenced CAS objects.

---

## Development Roadmap (Milestone 2 - Delta / Diff Synchronization)

1. [ ] Define structural specifications for record-level Delta Manifests.
2. [ ] Extend Server `Publisher` to optionally compute incremental delta files when previous release IDs are supplied.
3. [ ] Extend Client `CDSClient` synchronization algorithm to seek and apply delta mutations locally before full fallback checks.
