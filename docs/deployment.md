# Deployment: where a frontend gets its release

A publish turns the backend's content into a release in a store (`channels/`, `releases/`,
`objects/`, `media/`; see [schemas.md](schemas.md)). A frontend's build, or its running server,
syncs a release from a store and never reads the backend itself. What differs between setups is
**where the publish runs and how the store reaches the build**. There are three.

| | Publish runs | The build reads | The build needs |
| --- | --- | --- | --- |
| 1. Publish in the build | in the build, against the backend | the store the build just wrote | the backend reachable, a read token |
| 2. Committed release | wherever the backend is reachable | the store committed to the site's repository | nothing beyond the repository |
| 3. Remote storage | wherever the backend is reachable | a store on a file host or CDN (`CDS_URL`) | the store reachable |

## 1. Publish in the build

The build publishes first, then builds from the store it wrote:

```bash
cds-directus-publish --config directus-source.json --mapping cds/mapping.ts --out .cds/published
nuxi generate   # or any build that syncs from .cds/published
```

The simplest setup, and the closest to a site that queries the backend while it builds: every build
shows the backend's current content. It ties the build to the backend, though. The backend has to
be reachable from wherever the build runs (CI runners, `docker build`), the build needs a read token,
two builds of the same commit can show different content, and the release each build used is gone
with the build. If the backend is down, nothing can be built.

Use it when the build runs next to the backend, for example on the same host or network.

## 2. Committed release

The publish runs where the backend is reachable (an editor's machine, a job next to the backend),
and the store is committed to the site's repository. The build reads the release from the
repository, the same way a site is built from static files:

```bash
# where the backend is reachable
cds-directus-publish --config directus-source.json --mapping cds/mapping.ts \
  --out .cds/published --report .cds/report
git add .cds/published .cds/report && git commit -m "content: publish"

# anywhere: CI, docker build, a laptop
nuxi generate
```

- **No backend at build time.** CI and container builds need no network access to the backend and no
  token; a build of a commit is reproducible, and a commit is a deployable state of code and content.
- **Content changes are reviewable.** A publish is a commit: its diff shows which collections and
  media changed (objects are named by hash, so an unchanged collection is the same file), and the
  report next to it shows the checks and recommendations. Reverting content is reverting a commit.
- **Size.** Objects and media are written once and never change, so the repository grows by what a
  publish changes. Release retention and garbage collection
  ([server.md](server.md#release-retention)) keep the working tree to the last releases; Git keeps
  the history. Large media libraries may be better served by setup 3.
- **The report and source map** name the backend's URL (deep links back to the source) but hold no
  credentials. Commit them when they are useful to whoever reviews a publish; a preview with editing
  needs the source map from the same publish as its release.
- **Updates need a commit.** Content reaches the site only through a commit and a build, which is the
  point; a site that should follow the backend without a code change wants setup 3.

hotelplatform.io uses this setup ([directus.md](directus.md#case-study-hotelplatformio)): its
backend isn't reachable from CI, and its Docker image is built from the committed release.

## 3. Remote storage

The publish writes the store to a location the build or the running site can reach: a folder that a
web server or CDN serves, and later an object store. The build or server syncs from it by URL:

```bash
# where the backend is reachable; the store is a served folder
cds-directus-publish --config directus-source.json --mapping cds/mapping.ts --out /srv/cds
# the build or the running site
CDS_URL=https://cds.example.com nuxi generate
```

- Only the channel manifest changes; releases, objects and media can be cached forever
  ([schemas.md](schemas.md)), and a client downloads only the objects it doesn't have.
- A running server can follow the channel and switch releases without a rebuild
  (`CDSClient.sync()`, [client.md](client.md)); a static build syncs once.
- The client reads a store over HTTP (`HttpDownloader`) or from a folder (`FilesystemDownloader`).
  The publisher writes to a folder (`FilesystemStore`); writing to S3-compatible storage directly is
  not implemented yet ([implementation-plan.md](implementation-plan.md), G11). Until then the folder
  has to be one the web server or CDN serves, or synced to one.

## Choosing

- The backend is reachable from where builds run, and builds should always show current content: 1.
- Builds run where the backend isn't reachable (CI, image builds), or content should be reviewed and
  versioned with the code: 2.
- Several frontends share one release, a running site should update without a rebuild, or the media
  is too large for a repository: 3.

The setups can be combined: publish to a served store (3) and commit the release a production build
uses (2), or start with 1 locally and 2 in CI. A frontend is the same in every setup; only `CDS_URL`
and where the publish runs change.
