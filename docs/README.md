# CDS Documentation

The Content Distribution System (CDS) moves content out of a CMS and into immutable, content-addressed JSON files that clients download, verify and query locally. This folder documents the code in this repository as it is currently implemented (Milestone 1).

| Document | What it covers |
| --- | --- |
| [goals.md](goals.md) | Purpose, goals with current status, principles, non-goals, milestones |
| [implementation-plan.md](implementation-plan.md) | What's done (G1–G9, image processor, report, llms.txt) and the proposed next groups (G10–G13) |
| [schemas.md](schemas.md) | The v1 JSON schemas (manifests, collections, media metadata, JSON-LD, site structure, menus, targets) and the storage layout |
| [server.md](server.md) | `@cds/server`: `Publisher`, content sources, object stores, retention and garbage collection |
| [client.md](client.md) | `@cds/client`: `CDSClient`, the sync algorithm, storage adapters, the query API |
| [directus.md](directus.md) | `@cds/directus`: publishing from Directus, and a Directus-compatible read API over a synced release (with the hotelplatform.io case study) |
| [imaging.md](imaging.md) | `@cds/imaging`: the complementary image processor (crops, focal points, sizes per breakpoint) |
| [demo.md](demo.md) | `@cds/demo`: the multilingual landing page generator that runs the full pipeline end to end |

For what the project is trying to achieve and how far along it is, see [goals.md](goals.md).

## How the pieces fit

```
 demo/data/*.json            @cds/server                     storage root               @cds/client
 (or any CMS)                                                 (FS today, S3/CDN later)
┌──────────────┐  getCollections  ┌───────────┐  write   ┌──────────────────────┐  fetch*   ┌───────────┐
│ ContentSource│ ───────────────▶ │ Publisher │ ───────▶ │ channels/<ch>/...    │ ◀──────── │ CDSClient │
│  (adapter)   │  getMedia        │           │          │ releases/<id>.json   │           │           │
└──────────────┘                  └───────────┘          │ objects/<sha>.json   │           └─────┬─────┘
                                   validate, hash,        │ media/<sha>.<ext>    │                 │ save/read
                                   retention, GC          └──────────────────────┘           ┌─────▼──────┐
                                                                                             │ClientStorage│
                                                                                             │(memory, FS) │
                                                                                             └────────────┘
```

1. A **content source** returns collections (arrays of items) and media buffers.
2. The **publisher** validates each collection, serializes it deterministically, hashes it with SHA-256 and writes it to `objects/<hash>.json`. Media goes to `media/<hash>.<ext>`.
3. The publisher writes a **release manifest** that maps collection names and media paths to those hashes, then updates the **channel manifest** to point at the new release. The channel manifest is written last, so a client never sees a release whose files are incomplete.
4. The **client** reads the channel manifest, fetches the release manifest, downloads only the hashes it doesn't already have, verifies each one, and switches its active release pointer only after every file has passed verification.
5. Applications query the active release through the client's in-memory cache (`getCollection`, `getItemByKey`, `resolveReferences`, ...).

## Repository layout

```
cds/
├── schemas/v1/            JSON Schemas shared by server and client
├── server/src/
│   ├── core/publisher.ts  Publish, retention, garbage collection
│   ├── sources/fixture.ts In-memory ContentSource
│   ├── storage/filesystem.ts  ObjectStore on the local disk
│   ├── types.ts, utils.ts, validation.ts
├── imaging/src/           @cds/imaging: image processor (not part of CDS core)
├── client/src/
│   ├── core/client.ts     CDSClient: sync and query API
│   ├── storage/           MemoryStorage, FilesystemStorage
│   ├── types.ts, utils.ts, validation.ts
├── demo/                  Landing page generator (see demo.md)
└── tests/integration.test.ts  End-to-end lifecycle test
```

## Common commands

All commands run from the repo root (pnpm workspace).

| Command | Effect |
| --- | --- |
| `pnpm install` | Install dependencies for all workspace packages |
| `pnpm build` | Compile `server`, `client` and `imaging` with `tsc` into their `dist/` folders |
| `pnpm test` | Run the Vitest integration suite (imports from `src`, so no build needed) |
| `pnpm demo` | Build the packages and generate the static demo site into `demo/dist/` |
| `pnpm demo:serve` | Build and serve the demo with Hono (routes resolved per request, images rendered on first request) |
| `pnpm demo:images` | Pre-generate all demo images into the server's image cache |

## Terms

| Term | Meaning |
| --- | --- |
| **Channel** | A named pointer (e.g. `production`, `staging`) to one release. The only mutable file clients poll. |
| **Release** | An immutable snapshot: a manifest listing every collection hash and media hash. |
| **Collection** | A named array of items, stored as one JSON object. |
| **Item** | A record with `id`, `key`, `translations` and optional `references` / `media`. |
| **CAS** | Content-addressed storage: files are named by the SHA-256 of their contents, so identical content is stored and downloaded once. |
| **Virtual path** | The logical media name used in content (`products/tshirt.png`), mapped to a hash by the release manifest. |
