# CDS — Content Distribution System

TypeScript pnpm monorepo (ESM, `NodeNext`). The CMS publishes content-addressed JSON releases to an object store, and clients sync and verify them, then query them locally. Detailed docs are in `docs/` (goals.md, server.md, client.md, schemas.md, demo.md). `docs/goals.md` has the goals and their current status, so check proposed work against it and update the status column when a goal moves. Read the relevant one before changing behaviour, and update it when you change behaviour.

## Layout
- `schemas/v1/*.json`: the wire format (JSON Schema draft-07). This is the source of truth.
- `server/` (`@cds/server`): `Publisher`, `ContentSource` / `ObjectStore` interfaces, `FixtureSource`, `FilesystemStore`
- `client/` (`@cds/client`): `CDSClient`, `ClientStorage` / `RemoteDownloader` interfaces, `MemoryStorage`, `FilesystemStorage`
- `directus/` (`@cds/directus`): `DirectusSource` (GET-only publishing from Directus), `cds-directus-publish` CLI, `createDirectusCompat` (Directus REST semantics over a synced client). See docs/directus.md.
- `imaging/` (`@cds/imaging`): complementary image processor (sharp): crops by focal point, sizes per breakpoint. Not CDS core; the demo generator uses it after sync.
- `demo/`: publishes `demo/data/*.json`, syncs it, and builds an EN/DE site from `_routes`/`_pages`/`_blocks`/`_menu` (static files or a Hono server)
- `tests/integration.test.ts`: a single end-to-end lifecycle test (publish, sync, CAS reuse, retention, GC)

## Commands
- `pnpm test`: Vitest, imports from `src`, no build needed
- `pnpm build`: `tsc` for server, client, imaging and directus (demo and apps using them import their `dist`)
- `pnpm demo`: builds, then writes the static site (one file per route and language) to `demo/dist/`
- `pnpm demo:serve`: the same site served by Hono (SSR), routes resolved per request, images rendered on first request; `pnpm demo:images` pre-generates them into `demo/cache-site/`. The demo compiles to `demo/build/`; each mode works in `demo/.work/<mode>/`
- No lint config exists, even though a `lint` script is defined.

## Conventions and gotchas
- **CDS reports, it doesn't transform.** No machine translation, AI processing or image rendering in CDS; those run in the CMS or complementary projects. CDS carries their results (`_provenance` markers) and reports.
- Reserved names: item field `_provenance`; collections `_media` (media metadata, validated against the release's media) and `_jsonld` (schema.org definitions); optional site structure `_routes`, `_pages`, `_blocks` and menus `_menu` (validated only when present). The JSON-LD path reader exists in both server (validation, report) and client (resolution); keep them in sync. Only names the schema defines are CDS fields.
- Relative imports need a `.js` extension (`./types.js`), because of NodeNext ESM.
- `server/src/types.ts` and `client/src/types.ts` duplicate the wire types on purpose (the packages are independent). Change both together, along with the schema in `schemas/v1/`.
- Collection hash = `sha256(deterministicStringify(collection))`, which sorts keys recursively and adds no whitespace. The exact serialized string is what gets stored, and the client hashes the raw downloaded text. Never pretty-print, re-stringify or reorder object bytes.
- Commit ordering is the atomicity guarantee. Server: validate and check targets in memory (an unmet requirement throws before any write) → objects/media → release manifest → **channel manifest last**. Client: stage in memory, verify every hash, then save, then `setActiveReleaseId`. Preserve this order.
- `CDSClient.sync()` never throws. It returns `{ success: false, error }` and keeps serving the old release.
- Release retention sorts IDs **lexicographically**, so IDs must sort chronologically. Stores map characters outside `[a-zA-Z0-9_-]` in IDs and channel names to `_`.
- The client passes the active release ID as `currentEtag` (it's not a real HTTP ETag).
- The client uses Node `crypto`/`Buffer`. It isn't browser-ready yet.
- The server throws if schema files are missing. The client falls back to loose inline schemas (`client/src/validation.ts`).

## Not implemented yet (don't assume these exist)
S3 store, IndexedDB storage, client-side rollback API, client object/media GC, delta sync (Milestone 2). Image rendering lives in `imaging/`, not in CDS core.

## Git
Branch `dev`, main branch `main`. Commit style: conventional commits (`feat(cds): …`, `feat(demo): …`).
