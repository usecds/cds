# @cds/directus

Puts CDS between a Directus instance and a frontend that was written against Directus. Two halves:

- **`DirectusSource`** (publishing): a `ContentSource` that reads Directus with GET requests only and publishes its records and the files they reference as a CDS release.
- **`createDirectusCompat`** (consuming): a read-only, Directus-compatible API over a synced `CDSClient`. It answers the same REST paths and query parameters with the same response shapes, so a frontend keeps its Directus queries and mappers and only swaps the transport.

```
Directus ──GET──▶ DirectusSource ─▶ Publisher ─▶ store (folder / CDN)
                                                     │
frontend ◀── createDirectusCompat ◀── CDSClient ◀────┘  sync, verify, cache
  (/items, /files, /assets with the same params as before)
```

The frontend then needs no Directus URL or token at build or run time. It reads a verified, immutable release, and the release can be rolled back or kept on a channel like any other.

Proven against a real site: the hotelplatform.io Nuxt app was moved onto CDS this way (see [Case study](#case-study-hotelplatformio)).

## Publishing: `DirectusSource`

```ts
import { Publisher, FilesystemStore } from "@cds/server";
import { DirectusSource } from "@cds/directus/source";

const source = new DirectusSource({
  url: "http://localhost:8055",
  token: process.env.DIRECTUS_API_TOKEN, // read-only is enough: GET only
  defaultLocale: "en-gb",
  collections: {
    pages: { fields: "*,content_blocks.*,content_blocks.content.*", localized: ["title"] },
    menu_items: { fields: "*,to.slug,to.id,menu.id,menu.position" },
    languages: { primaryKey: "code" },
    styles: { fields: "*", key: "name" }
  },
  optional: ["templates"] // may be missing or forbidden: skipped with a log line
});
await new Publisher(source, new FilesystemStore(".cds/published")).publish("production", releaseId);
```

Per collection:

| Option | Meaning |
| --- | --- |
| `fields` | Directus `fields` to fetch (default `*`). This is the **union of what the frontend requests**, because the compat API can only project from what was published. Always include the primary key of an expanded relation (`menu.id` next to `menu.position`); the source logs a warning when it's missing. |
| `primaryKey` | Default `id`, or `code` when rows have no `id` (as in `languages`) |
| `key` | Field used as the CDS item key (default `slug`, else the primary key) |
| `localized` | Fields copied into `translations[defaultLocale]`, so CDS can check and report on them. Directus translation rows (`translations: [{ languages_code, ... }]`) are mapped to further locales. |

What gets published:

- **One CDS item per record**: `{ id, key, translations, media, directus }`. `directus` is the record exactly as Directus returned it, with key order normalized by CDS's canonical JSON. `media` lists the files the record references.
- **Files**: every UUID in any record (as a field value, or inside text such as `/assets/<id>`) is matched against `/files`. Only referenced files are published, under `directus/<id><ext>`.
- **`_media`**: per file, `alt` from the Directus title, `description`, `width`/`height`, the focal point normalized to 0–1, a readable `name` from `filename_download`, and the full Directus file record under `directus`. The publish report flags missing descriptions and similar issues like for any source.
- **Source map**: admin links to each record (`/admin/content/<collection>/<id>`) and file (`/admin/files/<id>`).

### CLI

```
cds-directus-publish --config directus-source.json --out .cds/published
                     [--channel production] [--release <id>] [--targets targets/] [--report .cds/report]
```

`DIRECTUS_URL` and `DIRECTUS_API_TOKEN` (or `DIRECTUS_TOKEN`) override the config. Release IDs default to the ISO time, so they sort chronologically. It writes `report.json`, `index.html` and `source-map.json` to the report directory.

## Consuming: `createDirectusCompat`

```ts
import { createDirectusCompat } from "@cds/directus/compat";

const directus = createDirectusCompat(client, { transform }); // client: a synced CDSClient
await directus.request("/items/menu_items?filter[status][_eq]=published&fields=*,to.slug&sort=sort");
await directus.items("pages", { "filter[permalink][_eq]": "/about", limit: 1 });
await directus.item("languages", "de-de");
await directus.file(id, { fields: "id,title" });
await directus.asset(id, { width: 512, format: "webp" }); // { data, type, filename }
```

`@cds/directus/compat` has no runtime dependencies. It accepts anything with `getCollection` and `getMediaContent`.

Supported query semantics:

| Directus | Compat |
| --- | --- |
| `filter` (flat `filter[a][b][_op]` or nested object, `_and`) | `_eq`, `_neq`, `_in`, `_nin`, `_null`, `_nnull`, `_empty`, `_nempty`, `_contains`, `_icontains`, `_starts_with`, `_ends_with`, `_gt(e)`, `_lt(e)`. Related records compare by primary key; to-many paths match if any related row matches. |
| `sort` | Multiple fields, `-` for descending, nulls last. Without a sort, rows keep the order Directus returned at publish time (its default sort). |
| `limit` / `offset` | Default limit 100 like Directus; `-1` for all |
| `fields` | `*` keeps scalar fields and collapses relations that weren't requested to their key; `a.b` projects into relations; M2A `item:collection` |
| `deep[rel][_sort]` | Sorts nested to-many arrays. Other `deep` options aren't supported. |
| `/assets/<id>` | The original, or transformed when transform params (`width`, `height`, `fit`, `format`, `quality`, `withoutEnlargement`, `transforms`) are given and a `transform` is configured |

Like Directus, unknown or empty collections, items and files answer **403**. Paths other than items, files, assets and `/server/ping|health` throw a 404 `DirectusCompatError`.

**Transforms**: CDS doesn't transform. `transform` is a hook the app supplies, typically sharp applying the same parameters Directus would. Output matches Directus in size and format. Bytes differ slightly with the sharp/libvips version.

## Case study: hotelplatform.io

The Nuxt 4 site (`hotelplatform-io`, template `hotelplatform`) was moved onto CDS in a separate worktree, branch `cds/directus-via-cds`. Neither the original checkout nor Directus was modified.

What changed in the app:

- `cds/directus-source.json`: the collections and fields the app reads (the union of its queries).
- `cds/content.ts`: `useCds()` creates the `CDSClient` (`CDS_URL` is a folder or a CDN URL; `CDS_CHANNEL`; `CDS_CACHE_DIR`; `CDS_SYNC_INTERVAL` for a running server), plus the compat API with a sharp `transform`. `directusGet()` and `directusApi()` are drop-ins for the `$fetch`/`ofetch` calls.
- About 15 call sites (server routes, the canonical-redirect middleware, the prerender hooks that download assets, icons, favicon and covers, resolve the style, and list paths): `$fetch(`${directusUrl}/items/...`)` became `directusGet('/items/...')`. Queries and mappers are unchanged.
- `server/routes/_cds/directus/[...path].get.ts`: a CDS-backed Directus-compatible route. `runtimeConfig.directus.url` points at it, so the template's integrations bundle, which builds Directus URLs itself, reads through CDS without changes to the shared template.
- `nuxt.config.ts`: no Directus URL or token, and the image provider is `none`. The `npm run cds:publish` script was added.

Result (`NUXT_ASSETS_MODE=local nuxt generate`, without any `DIRECTUS_*` variable, compared with the unmodified app built against the same Directus):

- The same 41 pages and 92 prerendered routes.
- The **rendered markup of all 41 pages is identical**, apart from build hashes and Nuxt's random per-render IDs. Style blocks are identical.
- **All `_payload.json` data and all prerendered `/api/*` responses are identical**. The only difference is that nested object keys are sorted (CDS's canonical JSON).
- The asset manifest and `manifest.webmanifest` are identical. Image variants have the same dimensions and format. Pixels differ by under 1/255 on average (a different sharp/libvips build from Directus').

Things to know:

- **Field sets must cover the frontend's queries.** A relation the frontend expands must be expanded at publish time too, including its key (`menu.id`).
- **The token's permissions decide what is published.** Collections the read token can't see (here `templates`, `modules_vimeo_player`) are skipped when listed as `optional`. Draft content is published if the token can read it; frontends filter on `status` as before.
- **Nitro's route cache outlives a build** (`node_modules/.cache/nuxt/.nuxt/cache`). After a new release, run the app's `clean` script before generating, or cached `/api` responses from the previous release are served. This applied to Directus before, too.
