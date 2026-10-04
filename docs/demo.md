# Demo (`@cds/demo`)

The demo is a static site generator that runs the full CDS pipeline in one process: it publishes a release, syncs it into a client cache, and renders a bilingual (EN/DE) landing page from the client's query API. Everything lives in [`demo/src/build-demo.ts`](../demo/src/build-demo.ts).

## Run it

```bash
pnpm install
pnpm demo
```

Open `demo/dist/index.html` (English) or `demo/dist/index-de.html` (German) in a browser. The page loads Tailwind from its CDN, so styling needs network access.

## What happens

```
demo/data/*.json ──▶ FixtureSource ──▶ Publisher ──▶ demo/published/   ("the CDN")
                                                          │
                                         DemoLocalDownloader
                                                          ▼
                                    CDSClient + FilesystemStorage ──▶ demo/cache/
                                                          │
                                        getLocales / getItemByKey / getCollection
                                                          ▼
                                         demo/dist/index.html, index-de.html
```

1. **Clean.** Deletes `demo/published`, `demo/cache` and `demo/dist`, so every run starts from scratch (all three are git-ignored).
2. **Server side.** Reads the JSON files in `demo/data/` and the media files in `demo/data/media/`, wraps them in a `FixtureSource`, and publishes them with a `Publisher` + `FilesystemStore` to channel `demo-channel` as release `release_demo_<Date.now()>`. The source locale is `en`. Targets are loaded from `demo/targets/` (`landing-page.json`; no `default.json`, so the built-in default applies). Translation completeness and the target results are printed to the console.
3. **Client side.** Creates a `CDSClient` with `FilesystemStorage("demo/cache")` and a `DemoLocalDownloader` that reads files from `demo/published` (a local stand-in for HTTP). The client is configured with `target: "landing-page"`. Calls `initialize()` and then `sync("demo-channel")`, and aborts if the sync fails.
4. **Generator.** For each locale returned by `client.getLocales()`, it:
   - gets the `homepage` item from `site_settings` by key, for hero, CTA and footer texts
   - gets the `features`, `goals` and `testimonials` collections
   - renders every image through the image processor ([imaging.md](imaging.md)): for each preset of the `landing-page` target, one variant per breakpoint (`mobile` 0, `tablet` 768, `desktop` 1280) and pixel ratio (1x, 2x), written to `demo/dist/media/<variant key>.webp`. Each image becomes a `<picture>` with a `<source media="(min-width: …)">` per breakpoint, so the browser loads the file for the screen size. Variants are reused across both language pages; 2x sizes the source can't fill are skipped. Originals aren't copied to `dist`.
   - shows the hero image (`hero` preset, 2:1) with its localized alt text.
   - shows the **language-specific pipeline diagram** (`content` preset, `fit`): the homepage item references `cds-flow.png` in `translations.en.media` and `cds-flow-de.png` in `translations.de.media`, and the generator takes `content.media[0]` for the current locale.
   - shows **one image in three crops**: `coast-with-lighthouse-balloon-sailboat.png` at the `banner` (3:1), `square` (1:1) and `portrait` (2:3) presets, each centered on a different named focal point (`lighthouse`, `balloon`, `sailboat`) from `_media`, with zoom 1, 1.5 and 1.3 so the crops isolate their subject.
   - renders an HTML page with `item.translations[locale]` and writes `index.html` (for `en`) or `index-<locale>.html`
   - adds a "release log" panel showing the active release ID, loaded collections and synced locales, read from the client

## Content

| File | Collection | Items | Localized fields |
| --- | --- | --- | --- |
| `site_settings.json` | `site_settings` | 1 (`key: homepage`) | `siteTitle`, `heroTitle`, `heroSubtitle`, `ctaPrimary`, `ctaSecondary`, `footerText` |
| `features.json` | `features` | 4 | `title`, `description` |
| `goals.json` | `goals` | 4 | `title`, `icon` |
| `testimonials.json` | `testimonials` | 2 | `quote`, `author`, `role` |
| `_media.json` | `_media` | 4 (`hero.svg`, both diagrams, coast image) | `alt`, `description` (plus `focalPoint`, `focalPoints`, `width`, `height`) |

Media files live in `demo/data/media/`, named by their virtual path. `unused-example.svg` isn't referenced by any item, so the publisher leaves it out and prints a warning; it never reaches `demo/dist/`.

Each file is a plain array of CDS items (`id`, `key`, `translations`). To change the page, edit the JSON and run `pnpm demo` again.

## Things to try

- **Add a locale.** Add a `"fr": { ... }` block to every item, and `getLocales()` will pick it up so `index-fr.html` gets generated. The language switcher in the header is hard-coded to EN/DE, and a few strings in the release log panel are chosen with `locale === 'en'`, so extend those too.
- **Inspect CAS output.** After a run, look at `demo/published/releases/*.json` and the matching `objects/<hash>.json` files, then compare with `demo/cache/`.
- **See validation.** Remove the `key` from an item: the publish fails with an `Invalid Collection (...)` error from the schema validator.

## Notes

- Each run publishes a single release to a clean store, so retention, GC and CAS reuse across releases don't come into play here. The integration test (`tests/integration.test.ts`) covers those.
- `DemoLocalDownloader` doesn't sanitize release IDs. That's fine for `release_demo_<number>`, but IDs with characters outside `[a-zA-Z0-9_-]` would need the same mapping the stores use (see [server.md](server.md#objectstore)).
