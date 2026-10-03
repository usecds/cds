# CDS — Content Distribution System

TypeScript pnpm monorepo (ESM, `NodeNext`). The CMS publishes content-addressed JSON releases to an object store, and clients sync and verify them, then query them locally. Detailed docs are in `docs/` (goals.md, server.md, client.md, schemas.md, demo.md). `docs/goals.md` has the goals and their current status, so check proposed work against it and update the status column when a goal moves. Read the relevant one before changing behaviour, and update it when you change behaviour.

## Layout
- `schemas/v1/*.json`: the wire format (JSON Schema draft-07). This is the source of truth.
- `server/` (`@cds/server`): `Publisher`, `ContentSource` / `ObjectStore` interfaces, `FixtureSource`, `FilesystemStore`
- `client/` (`@cds/client`): `CDSClient`, `ClientStorage` / `RemoteDownloader` interfaces, `MemoryStorage`, `FilesystemStorage`
- `demo/`: generates an EN/DE landing page from `demo/data/*.json` through publish → sync → render
- `tests/integration.test.ts`: a single end-to-end lifecycle test (publish, sync, CAS reuse, retention, GC)

## Commands
- `pnpm test`: Vitest, imports from `src`, no build needed
- `pnpm build`: `tsc` for server + client (demo imports their `dist`)
- `pnpm demo`: builds, then writes `demo/dist/index.html`, `index-de.html`
- No lint config exists, even though a `lint` script is defined.

## Conventions and gotchas
- **CDS reports, it doesn't transform.** No machine translation, AI processing or image rendering in CDS; those run in the CMS or complementary projects. CDS carries their results (`_provenance` markers) and reports.
- Reserved names: item field `_provenance`; collection `_media` (media metadata, validated against the release's media). Only names the schema defines are CDS fields.
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
S3 store, Directus source, IndexedDB storage, HTTP downloader, client-side rollback API, client object/media GC, delta sync (Milestone 2). Image rendering is a separate project, not part of CDS.

## Git
Branch `dev`, main branch `main`. Commit style: conventional commits (`feat(cds): …`, `feat(demo): …`).
