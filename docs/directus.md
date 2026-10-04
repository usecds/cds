# @cds/directus

The Directus source adapter. It puts CDS, as a data contract, between a Directus instance and a frontend:

- **Publishing (`DirectusSource`)**: reads Directus with GET requests only. A site **mapping** turns the records into the CDS contract (`_routes`, `_pages`, `_blocks`, `_menu`, plus the site's own collections). The frontend then reads CDS and never sees a Directus record, field name or relation, so either side can be replaced.
- **Editing (`DirectusEditor`, optional)**: the adapter's write side for an editable preview (goal P13). An edit addressed in CDS terms goes to the Directus field it comes from, with the editor's own session. Nothing is written into CDS.
- **Migration aid (`createDirectusCompat`)**: a Directus-compatible read API over a synced release. It lets an existing Directus frontend switch transport first and move to the contract later.

```
Directus ──GET──▶ DirectusSource ──mapping──▶ Publisher ─▶ store (folder / CDN)
   ▲                                  └─ source map (field → Directus field), next to the report
   │                                                        │
   │ PATCH (editor's session)                                ▼
DirectusEditor ◀── preview: /edit {address, value} ◀── frontend ◀── CDSClient (+ EditOverlay in a preview)
```

Proven on a real site: hotelplatform.io, rewritten to read CDS natively, renders the same 41 pages as before and has an editable preview (see the [case study](#case-study-hotelplatformio)).

## Publishing: `DirectusSource`

```ts
import { Publisher, FilesystemStore } from "@cds/server";
import { DirectusSource } from "@cds/directus/source";
import map, { mediaPath } from "./cds/mapping"; // the site's contract

const source = new DirectusSource({
  url: "http://localhost:8055",
  token: process.env.DIRECTUS_API_TOKEN, // read-only is enough: GET only
  defaultLocale: "en-gb",
  collections: {
    pages: { fields: "*,content_blocks.*,content_blocks.content.*,content_blocks.content.item.*" },
    menus: {},
    menu_items: {},
    languages: { primaryKey: "code" }
  },
  optional: ["modules_vimeo_player"], // may be missing or forbidden: skipped with a log line
  map,
  mediaPath
});
await new Publisher(source, new FilesystemStore(".cds/published")).publish("production", releaseId);
```

`collections` lists what to fetch (`fields`: the Directus `fields` parameter, default `*`; `primaryKey`: default `id`, or `code` for rows without one). The source also reads `/files`, to know the files the records reference.

### The mapping

```ts
type DirectusMapping = (records: Record<string, Row[]>, ctx: DirectusMapContext) => Record<string, MappedItem[]>;

interface DirectusMapContext {
  locale: string;                                   // the source locale (defaultLocale)
  media(fileId): string | null;                     // publishes a file, returns its media path
  file(fileId): FileMeta | null;                    // a file's metadata, without publishing it
  source(collection, id, field, { format?, editable? }?): SourceFieldRef; // for $sources
  log(message): void;
}

type MappedItem = CollectionItem & {
  $origin?: { collection: string; id: string | number }; // the record behind the item (admin link)
  $sources?: Record<string, SourceFieldRef>;             // field path in the item → Directus field
};
```

The mapping returns CDS collections. What the adapter does with them:

- **Files**: only files the mapping asks for with `ctx.media(id)` are published, under `mediaPath(file)` (default `directus/<id><ext>`). Each item's `media` list is derived from the media paths it holds, and each file gets a `_media` item: `alt` from the Directus title, `description`, `width`/`height`, the focal point normalized to 0–1, a readable `name`, and the uploaded `filename`.
- **Sources**: `$origin` and `$sources` are moved into the source map and are not published. A value with a source field can be edited in a preview; values the mapping derives (joined, computed) simply have none, or are marked `editable: false`.
- **Shape**: every item gets `translations` (an empty object when it has no texts). The site structure is validated as usual: routes, pages and blocks must resolve, menus must not cycle, external links must be absolute (`https://`, protocol-relative `//host`, `mailto:`, `tel:`).

Without a mapping the adapter publishes each record as it is, under `directus` (the raw mode the compat layer reads).

### CLI

```
cds-directus-publish --config directus-source.json --out .cds/published [--mapping cds/mapping.ts]
                     [--channel production] [--release <id>] [--targets targets/] [--report .cds/report]
```

`--mapping` loads a module whose default export (or `map`) is the mapping and that may export `mediaPath`. TypeScript modules work on Node 23.6+ (type stripping: erasable syntax, imports with their `.ts` extension). `DIRECTUS_URL` and `DIRECTUS_API_TOKEN` (or `DIRECTUS_TOKEN`) override the config. Release IDs default to the ISO time, so they sort chronologically. The report directory gets `report.json`, `index.html` and `source-map.json`; with `DEBUG` set, failures print their stack.

## Editing: `DirectusEditor`

The optional write side ([`SourceEditor`](server.md#editing-sourceeditor-optional)):

```ts
import { DirectusEditor } from "@cds/directus/editor";

const editor = new DirectusEditor({ url: "https://cms.example.com" });
const session = await editor.login({ email, password });              // the editor's own account
const result = await editor.write({ ref, value: "New title", basedOn: "Old title" }, session);
// { status: "saved", value } | { status: "conflict", current } | { status: "rejected", message }
```

- `ref` is the value's source field from the source map (`collection`, `id`, `field`); the write is a `PATCH /items/<collection>/<id>` of that one field, as the editor, so Directus applies the editor's permissions.
- **Conflicts**: before writing, the editor reads the field. If it no longer equals `basedOn` (what the editor saw), nothing is written and the current value comes back. Empty and `null` compare equal.
- An expired session throws `DirectusAuthError`; `refresh(session)` renews it with the refresh token. `editable: false` refs are rejected.
- `@cds/directus/editor` has no runtime dependencies and re-exports the edit types, so a frontend server can use it without `@cds/server`.

How a preview puts it together (from the case study): the page marks each editable text with its CDS address; the preview server resolves the address through the source map, takes the value the page showed as `basedOn`, calls `write`, and on success lays the new value over the release with an [`EditOverlay`](client.md#preview-edits-editoverlay) until the next release has it.

## Migration aid: `createDirectusCompat`

```ts
import { createDirectusCompat } from "@cds/directus/compat";

const directus = createDirectusCompat(client, { transform }); // client: a CDSClient synced from a raw (unmapped) publish
await directus.request("/items/menu_items?filter[status][_eq]=published&fields=*,to.slug&sort=sort");
await directus.asset(id, { width: 512, format: "webp" }); // { data, type, filename }
```

Answers Directus REST paths from a release published **without** a mapping: filters (`_eq`, `_neq`, `_in`, `_nin`, `_null`, `_nnull`, `_empty`, `_nempty`, `_contains`, `_icontains`, `_starts_with`, `_ends_with`, `_gt(e)`, `_lt(e)`; related records compare by key), multi-field `sort` (nulls last), `limit` (default 100) / `offset`, `fields` projection (`*` collapses unrequested relations to their key), `deep[rel][_sort]`, files, and assets with an app-supplied `transform`. Unknown collections, items and files answer 403, like Directus.

It keeps a frontend thinking in Directus, so it is a step, not the goal: the hotelplatform.io rewrite first ran on it (identical pages), then moved to the mapped contract.

## Case study: hotelplatform.io

The Nuxt 4 site (`hotelplatform-io`, template `hotelplatform`) was rewritten in separate worktrees (branch `cds/directus-via-cds` of the app and of the template). The original checkouts and the live Directus were not modified; edits were tested against a throwaway copy of the database.

**The contract** (`cds/mapping.ts` in the app): `_routes` (one per page, path computed at publish time from the menus with the site's own canonical-path rules, plus 301 routes for non-canonical menu paths), `_pages`, `_blocks` (type, layout settings, texts, image, feature items, modules), `_menu` (one root per menu position), and `site`, `languages`, `styles`, `posts`, `faqs`, `faq_groups`, `features`, `videos`, `integrations`, `integration_categories`. Files keep their names (`cms/<file id>.<ext>`). Every text records its Directus field.

**The app** reads CDS only:

- `cds/content.ts`: the synced client (`CDS_URL` folder or CDN, `CDS_CHANNEL`, `CDS_CACHE_DIR`, `CDS_SYNC_INTERVAL`), media by asset id, and image rendering with sharp (variants, icons, `/api/assets/<id>?width=…`).
- `cds/site.ts`: builds the frontend data and the `/api` responses the templates consume from the contract. The Directus query helper and all Directus mappers are gone; the build hooks (paths, assets, covers, favicon, icons, build style) and the canonical redirects read CDS too.
- The template's integrations bundle reads its collections through the auto-imported `cdsCollection(name)`.

**Result** (`NUXT_ASSETS_MODE=local nuxt generate`, no Directus variable set, compared with the unmodified app built from the same Directus): the same 41 pages and 92 routes; **identical markup on all 41 pages** (build hashes and Nuxt's random ids aside); identical asset files, asset manifest, web manifest, cover map, sitemap and robots.txt; identical page payloads and `/api` data except two values that are no longer part of the contract (the globals row id as a number, and FAQ junction row ids). The page-mapping snapshot tests of the old Directus mappers pass unchanged against the CDS path (two snapshots updated: orphaned `faqs_faq_groups` module rows without an item are no longer passed through).

**The editable preview** (`CDS_PREVIEW=1`, a server build; static builds are unaffected):

- Templates mark editable texts with `:data-cds-field="cdsField(block, 'title')"` (`#core`, template API 3.3). In a preview with an editor signed in, the data carries each text's CDS address (`$cds`), so the attribute appears; for visitors and in static builds the binding is `undefined` and Vue leaves it out. About 70 texts in 17 components: block titles, subtitles, rich-text contents, call-to-action texts, features, FAQs, menu labels and descriptions, footer texts.
- `app/lib/cdsEditor.ts` (loaded only on a preview): sign-in panel; click a marked text to edit it in place (plain text, or rich text with bold, italic, link); Ctrl+Enter saves, Esc cancels; conflicts and expired sessions are reported.
- Server: `/api/_cds/login|logout|session|edit`; the editor's Directus session is sealed in an httpOnly cookie; `/api/_cds/edit` resolves the address through the source map, uses the value the page showed as `basedOn`, writes with `DirectusEditor`, and lays the saved value over the release (shown to everyone on the preview at once); a newer release replaces it.
- Verified end to end against the sandbox, in dev and in a production build, by API and in a browser: 30 marked texts on the home page for the editor, none for visitors; plain and rich edits land in the right Directus fields (e.g. `block_hero.title` for a hero's title, `block_tailwind_hero.content` for rich text) and show immediately; a value changed in Directus meanwhile comes back as a conflict; unauthenticated edits get 401; after the next publish the overlay gives way to the release.

Things to know:

- **A preview build differs from a static one.** Pages and `/api` responses must not be prerendered or cached there (the site's route rules cached `/api/**` for 60 s, and Nitro runs cached handlers without the request's body and cookies), and server-side data fetches must forward cookies (`useFetch` / `useRequestFetch`, not a plain `$fetch`). The app switches all of that on `CDS_PREVIEW`.
- **The read token decides what is published.** Draft content is published if the token can read it; the site filters on `status` as before.
- **Nitro's route cache outlives a build** (`node_modules/.cache/nuxt/.nuxt/cache`): run the app's `clean` script before generating from a new release.
