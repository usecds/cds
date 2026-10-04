# Image processor (`@cds/imaging`)

A complementary package, separate from `@cds/server` and `@cds/client`. CDS itself doesn't transform content (see [goals.md](goals.md)), so CDS carries the inputs and this package renders the images:

- the **original** media file (from the release)
- its **focal points** and intrinsic size (from the `_media` collection)
- the **sizes per screen size** (from the target's `media` section)

It's built on [sharp](https://sharp.pixelplumbing.com/). In the demo it runs in the site generator, after sync; rendered variants are written to the generator's output and never enter a release.

```
imaging/src/index.ts   render, cropRegion, responsiveSizes, variantKey, canonicalOptions, parseAspect, isVector
```

## Target contract: breakpoints and presets

A target declares the screen sizes it supports and, per preset, the width to render at each of them:

```json
"media": {
  "breakpoints": { "mobile": 0, "tablet": 768, "desktop": 1280 },
  "dpr": [1, 2],
  "presets": {
    "banner":  { "aspect": "3:1", "fit": "fill", "formats": ["avif", "webp"],
                 "widths": { "mobile": 640, "tablet": 960, "desktop": 1152 } },
    "content": { "fit": "fit", "formats": ["webp", "png"], "lossless": true,
                 "widths": { "mobile": 640, "tablet": 960, "desktop": 1152 } }
  }
}
```

| Field | Meaning |
| --- | --- |
| `breakpoints` | Name → minimum screen width in CSS pixels. Shared across targets: one name, one width (a different value fails the build). |
| `dpr` | Device pixel ratios to render (default `[1]`). |
| `presets.*.aspect` | Output aspect ratio, required for `fill`. |
| `presets.*.fit` | `fill` crops to exactly the aspect ratio (default); `fit` scales inside without cropping. |
| `presets.*.widths` | Breakpoint name → width in CSS pixels. Only declared breakpoints may be used. |
| `presets.*.formats` | Formats to render (`avif`, `webp`, `jpeg`, `png`; default `["webp"]`). The **last** one is the universal fallback for the `<img>` element. |
| `presets.*.quality` | 1–100; default per format (`DEFAULT_QUALITY`: AVIF 50, WebP/JPEG 80), because the scales differ: AVIF 50 looks about like WebP 80. |
| `presets.*.lossless` | Lossless output for WebP, AVIF and PNG. Use it for diagrams and screenshots, where lossy compression blurs text and thin lines. |
| `presets.*.background` | JPEG only: color behind transparent areas (default `#ffffff`). |

Widths are declared explicitly per breakpoint, not derived. Rendered pixels = CSS width × DPR.

## Formats

Measured on the demo images (1152 px wide):

| Format | Coast photo | Pipeline diagram (transparent) |
| --- | --- | --- |
| JPEG q80 | 105 KB | 56 KB, **transparency lost** |
| WebP q80 | 93 KB | 31 KB |
| WebP lossless | 600 KB | 81 KB |
| AVIF q50 | 45 KB | 21 KB |
| PNG (lossless) | 1086 KB | 131 KB |

- **AVIF** is about half the size of WebP for photos, but encodes about 4x slower. That's fine in a build, where each variant is rendered once.
- **WebP** works in practically every browser and is the usual fallback.
- **Transparency:** JPEG can't store it. When a transparent source is rendered as JPEG, it's flattened onto `background` and `render()` reports `flattened: true`.
- **Text and line art:** use `lossless`. Without it, sharp writes PNG as a 256-color palette (lossy).
- **Non-browser targets** (signage players, some TV apps) may only support JPEG/PNG, which is why formats are declared per target preset.

## Source order: smallest first

Inside `<picture>`, the browser takes the **first** `<source>` whose `media` and `type` both match. So generators should sort the formats within each breakpoint by **measured file size**, smallest first: every browser then loads the smallest format it supports. The order comes from the rendered files, not from a fixed ranking. In the demo, AVIF comes first for the photo, but lossless WebP beats PNG for the diagram, and with lossless output WebP can also beat AVIF.

## API

| Function | Purpose |
| --- | --- |
| `responsiveSizes(preset, breakpoints, dpr)` | Every size a preset needs: per breakpoint and DPR, largest breakpoint first (the order `<picture>` sources need) |
| `cropRegion(srcW, srcH, aspect, focalPoint?, zoom?)` | The source region a `fill` render keeps: largest region of the output aspect, shrunk by `zoom`, centered on the focal point, clamped to the edges |
| `render(bytes, options)` | Renders one variant: `{ data, width, height, format, upscaled }` |
| `variantKey(sourceHash, options)` | Identity of a variant, known before rendering: SHA-256 of the source hash and the canonical options |
| `isVector(mimeType)` | `true` for SVG. Vector images aren't rendered: they scale on their own, and rasterizing makes them larger and blurrier (the demo's 1.3 KB hero SVG became 3.6–5.3 KB per WebP). Generators serve the original. |

`RenderOptions`: `width`, `height` (required for `fill`), `fit`, `focalPoint`, `zoom` (≥ 1, `fill` only), `format`, `quality`, `lossless`, `background`. `RenderResult` adds `upscaled` and `flattened` for reporting.

`presetFormats(preset)` returns a preset's formats (default `["webp"]`), `MIME_TYPES` maps formats to the `type` attribute values, and `DEFAULT_QUALITY` holds the per-format defaults.

**Focal point and zoom.** Without zoom, a crop can only shift along one axis, so a focal point near an edge ends up at that edge. `zoom` crops a smaller region, so the subject can actually be centered. `upscaled: true` means the output has more pixels than the source region; the demo uses `cropRegion` beforehand to skip high-DPR sizes the source can't fill.

**Variant keys.** The canonical options contain only what changes the output: focal point and zoom count for `fill`, not for `fit`. Same source + same effective options = same key, so a generator renders each variant once (the demo reuses variants across language pages).

## Using it in a site generator

The demo's `picture()` helper (`demo/src/build-demo.ts`) shows the full flow. Vector images (`isVector`) skip all of it: the original is copied once and used in a plain `<img>`. A `fill` preset's aspect ratio is then not applied, so vector images should already have the intended proportions.

1. `client.getMediaInfo(path, locale)` → original hash, size, focal points, alt text.
2. `responsiveSizes(preset, breakpoints, dpr)` → sizes per breakpoint.
3. For each size and format: `variantKey` → render once → write `media/<key>.<format>`. File extension and MIME type follow the requested format (sharp reports AVIF output as `heif`).
4. Emit one `<source media="(min-width: …)" type="…" srcset="… 1x, … 2x">` per breakpoint and format, formats sorted by size within each breakpoint. The smallest breakpoint's sources have no `media`, and the `<img>` uses the fallback format:

```html
<picture>
  <source media="(min-width: 1280px)" type="image/avif" srcset="media/7671….avif 1x" width="1152" height="384">  <!-- 34.5 KB -->
  <source media="(min-width: 1280px)" type="image/webp" srcset="media/b4e7….webp 1x" width="1152" height="384">  <!-- 68.4 KB -->
  <source media="(min-width: 768px)"  type="image/avif" srcset="media/af67….avif 1x" width="960" height="320">
  <source media="(min-width: 768px)"  type="image/webp" srcset="media/a4dd….webp 1x" width="960" height="320">
  <source type="image/avif" srcset="media/6731….avif 1x, media/….avif 2x" width="640" height="213">
  <source type="image/webp" srcset="media/f2c2….webp 1x, media/8a61….webp 2x" width="640" height="213">
  <img src="media/f2c2….webp" srcset="media/f2c2….webp 1x, media/8a61….webp 2x"
       alt="Rocky coast with a red and white lighthouse…" width="640" height="213">
</picture>
```

The browser picks the file by screen width and pixel ratio; no CSS cropping is involved.

## Open

How rendered variants could come back into a release (verified and available offline on clients) is still open; see P3 in [goals.md](goals.md).
