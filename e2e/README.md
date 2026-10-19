# Browser end to end (G12)

A kiosk page (`app/`) in Chromium and WebKit syncs a release from S3 with `S3Downloader` into `IndexedDBStorage`. The test checks:

- the first sync, with the text and the media verified;
- a reload while S3 is unreachable, which serves the stored release;
- a `304` for an unchanged channel;
- the same page on the machine's LAN address over plain `http`, which isn't a secure context (no `crypto.subtle`, no Web Locks).

Setup:
- `global-setup.ts` publishes a fresh release under `<prefix>/e2e-g12` with the publisher key.
- It sets the bucket's CORS rules to allow `GET`/`HEAD` from any origin, so pages can read with a signed request.
- It bundles the page from the sources.
- The page reads with the device group's key.

```bash
npx playwright install chromium webkit   # once
CDS_S3_TEST_ENDPOINT=http://localhost:8333 CDS_S3_TEST_BUCKET=tenant-demo \
CDS_S3_TEST_PUBLISHER=<key>:<secret> CDS_S3_TEST_READER=<group key>:<secret> \
CDS_S3_TEST_PREFIX=hotelplatform pnpm test:e2e
```

The reader key must be able to read `<prefix>/e2e-g12/*`.
