# @usecds/directus

The Directus adapter for [CDS](https://github.com/usecds/cds):

- `DirectusSource`: publishes a Directus instance into a CDS release with GET requests only. A site mapping turns records into the CDS contract; the Directus fields behind each value go into the source map.
- `cds-directus-publish`: the publish as a CLI (`--config directus-source.json --out .cds/published [--mapping cds/mapping.ts]`).
- `DirectusEditor`: the optional write side for editable previews. An edit goes to the Directus field the source map names, as the signed-in editor.
- `createDirectusCompat`: Directus REST semantics over a synced raw release, to migrate a site that queries Directus.
- `mapContentTypes`: maps content types declared by a consumer (for example a template) from Directus records.

```
npm install @usecds/directus @usecds/server
```

Documentation: [docs/directus.md](https://github.com/usecds/cds/blob/main/docs/directus.md).
