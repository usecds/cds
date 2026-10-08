# @usecds/imaging

Image processing that complements [CDS](https://github.com/usecds/cds). CDS carries the original media files, their focal points and the sizes a target declares per breakpoint; this package renders the variants with [sharp](https://sharp.pixelplumbing.com/), so a site can prerender every image at build time and serve it as a static file.

- `render`: one variant (crop to an aspect ratio around the focal points, or fit; format, quality, lossless)
- `responsiveSizes`, `cropRegion`, `variantKey`, `canonicalOptions`, `parseAspect`, `isVector`
- `VariantCache`: renders a variant on first request and keeps it on disk

```
npm install @usecds/imaging
```

It is not part of CDS core: rendered variants never enter a release. Documentation: [docs/imaging.md](https://github.com/usecds/cds/blob/main/docs/imaging.md).
