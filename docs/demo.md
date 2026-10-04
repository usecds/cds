# Demo (`@cds/demo`)

The demo runs the full CDS pipeline in one process: it publishes a release, syncs it into a client cache, and builds a bilingual (EN/DE) site from the site structure in the content (`_routes`, `_pages`, `_blocks`, `_menu`). It has two generator modes:

| Mode | Command | Output |
| --- | --- | --- |
| **static** (default) | `pnpm demo` | One HTML file per route and language in `demo/dist/`, with relative links; for prerendered hosting |
| **hono** | `pnpm demo:serve` (or `--mode=hono --port=3000`) | A [Hono](https://hono.dev) server that resolves every request path through the client's routes at request time (SSR) |

## Run it

```bash
pnpm install
pnpm demo          # static: open demo/dist/index.html
pnpm demo:serve    # server: http://localhost:3000/
```

The pages load Tailwind from its CDN, so styling needs network access. The demo compiles to `demo/build/`; `demo/dist/` only holds the generated site.

## What happens

```
demo/data/*.json ──▶ FixtureSource ──▶ Publisher ──▶ demo/published/   ("the CDN")   + demo/reports/
                                                          │
                                                 DemoLocalDownloader
                                                          ▼
                                     CDSClient + FilesystemStorage ──▶ demo/cache/
                                                          │
                   getRoutes / getPage / getMenu / getAlternates / getJsonLd / getMediaInfo
                                ▼                                             ▼
                 static: demo/dist/ (files per route)          hono: server, rendered per request
```

1. **Clean.** Deletes `demo/published`, `demo/cache`, `demo/dist`, `demo/reports` and `demo/cache-site` (all git-ignored).
2. **Server side.** Every JSON file in `demo/data/` is a collection named after the file; the media files come from `demo/data/media/`. They're published to channel `demo-channel` as `release_demo_<Date.now()>`, with source locale `en` and the targets in `demo/targets/` (`landing-page.json`; no `default.json`, so the built-in default applies). The publish report goes to `demo/reports/` (`report.json` + `index.html`, also on failure); the console only prints its location.
3. **Client side.** A `CDSClient` with `FilesystemStorage("demo/cache")`, `target: "landing-page"` and a `DemoLocalDownloader` reading `demo/published` (a local stand-in for HTTP) syncs the release.
4. **Generator.** Shared by both modes ([`site.ts`](../demo/src/site.ts), [`blocks.ts`](../demo/src/blocks.ts)): for a route and language, `getPage()` gives the page and its blocks, and each block is rendered by its `type`. The layout adds:
   - `<title>`, meta description, canonical URL and `hreflang` alternates (from `getAlternates()`), with absolute URLs from `SITE_URL` (a placeholder, `https://cds.example.com`)
   - the `main` menu (`getMenu()`, with the nested "More" group) and a language switcher from the route's alternates
   - JSON-LD: a `WebPage` for the page, plus whatever the blocks' items define (`WebSite` for `site_settings`, a `Review` per testimonial), with page and image URLs added
   - the footer from `site_settings`, with a link to `llms.txt`
5. **Static mode** writes `<route path>/index.html` per route and language (`/` → `index.html`, `/de/bildverarbeitung/` → `de/bildverarbeitung/index.html`), with links relative to each file so the site also works when opened from disk. Redirect routes become forwarding pages (static hosts can't send a 301). It also writes `llms.txt` and `sitemap.xml` (with `hreflang` alternates).
6. **Hono mode** ([`server.ts`](../demo/src/server.ts)) resolves each request with `client.resolveRoute(path)`: pages are rendered per request, redirect routes answer with their status (`301`), unknown paths with `404`. Links are root-absolute. Images are rendered on first use into `demo/cache-site/media/` and served from `/media/` with `immutable` caching. `/llms.txt` and `/sitemap.xml` are generated on request. The server re-syncs every 30 seconds, so a newly published release is live without a rebuild: the use case for dynamic routing (P11).

## Site structure

| Route | Paths | Page | Blocks |
| --- | --- | --- | --- |
| `r_home` | `/`, `/de/` | `p_home` | `hero`, `steps` (how it works), `image` (language-specific diagram), `card-grid` (features), `icon-list` (design principles), `quotes` (testimonials), `release-log` |
| `r_imaging` | `/image-processing/`, `/de/bildverarbeitung/` | `p_imaging` | `page-header`, `note` (optional, early stage), `image-crops` (three crops), `image-report` (variants and costs) |
| `r_legacy_de` | `/index-de.html` | redirect → `r_home` (301) | the old German file name |

Menu `main`: How it works, Features, Principles (anchors to blocks on the home page), More → Image processing, GitHub. The hero's buttons are `_menu` link items too (`l_explore`, `l_source`).

**Block types** (rendered by the demo, not interpreted by CDS): `hero` (texts from its `site_settings` item, image, links), `page-header`, `steps`, `image` (`settings.preset`, `settings.caption`), `card-grid`, `icon-list`, `quotes`, `note`, `image-crops` (`settings.crops`: preset, named focal point, zoom), and the generator blocks `image-report` (costs of the images rendered on the page, rendered after the other blocks) and `release-log`. An unknown type is skipped with a warning.

## Images

Every raster image goes through the image processor ([imaging.md](imaging.md)), using the breakpoints (`mobile` 0, `tablet` 768, `desktop` 1280), pixel ratios (1x, 2x) and presets of the `landing-page` target: AVIF + WebP for photos, lossless WebP + PNG for the diagram. Each image becomes a `<picture>` with sources per breakpoint and format (smallest file first). Files get readable names such as `media/coast-lighthouse-banner-1152.7350c4c1.avif`. 2x sizes the source can't fill are skipped; the hero SVG is passed through as is. The language-specific diagram comes from the block's `translations[locale].media` (`cds-flow.png` / `cds-flow-de.png`).

## Content

| File | Collection | Notes |
| --- | --- | --- |
| `site_settings.json` | `site_settings` | Site title, hero title and subtitle, footer; `media: ["hero.svg"]` for the JSON-LD `WebSite` |
| `steps.json` | `steps` | The three "how it works" steps (`icon`, localized `title`, `text`, `badge`) |
| `features.json`, `goals.json`, `testimonials.json` | | Shown by the `card-grid`, `icon-list` and `quotes` blocks |
| `_routes.json`, `_pages.json`, `_blocks.json`, `_menu.json` | | Site structure (see above); all headings, intros, link labels and paths are content, so translation completeness covers them |
| `_media.json` | `_media` | Alt texts, descriptions, focal points and sizes of the 4 images |
| `_jsonld.json` | `_jsonld` | `WebSite` (site_settings), `Review` (testimonials), `WebPage` (`_pages`) |

Media files live in `demo/data/media/`. `unused-example.svg` isn't referenced by any item, so the publisher leaves it out with a warning.

The report shows one deliberate gap: the German description of the coast image is shorter than the recommended 50 characters. The German-only legacy redirect is listed under "items without source", since it has no English path.

## Things to try

- **Add a page.** Add a route, a page and a block or two to the `_` files, and a menu entry; both modes pick it up without code changes.
- **Live update (hono mode).** While `pnpm demo:serve` runs, the server re-syncs every 30 seconds; publish a new release into `demo/published/` to see it appear without a restart.
- **Add a locale.** Add `"fr"` translations (including route paths and menu labels); the language switcher, `hreflang` and sitemap follow the routes.
- **See validation.** Point a block at an unknown item or give two routes the same path: the publish fails before anything is written.

## Notes

- Each run publishes a single release to a clean store, so retention, GC and CAS reuse across releases don't come into play here. The integration test (`tests/integration.test.ts`) covers those.
- `DemoLocalDownloader` doesn't sanitize release IDs. That's fine for `release_demo_<number>`, but IDs with characters outside `[a-zA-Z0-9_-]` would need the same mapping the stores use (see [server.md](server.md#objectstore)).
