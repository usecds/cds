# @usecds/s3

S3-compatible storage for [CDS](https://github.com/usecds/cds): releases in a bucket (AWS, SeaweedFS, RustFS, Ceph, R2), read by devices with signed requests and no proxy.

- `@usecds/s3/store`: `S3Store`, the publisher's store. Same layout as the folder store, under a prefix per project. Node only.
- `@usecds/s3/downloader`: `S3Downloader`, the client's downloader. SigV4-signed GETs with a device group's read-only key, `304` when nothing changed. Signs with Web Crypto.

```ts
import { Publisher } from "@usecds/server";
import { S3Store } from "@usecds/s3/store";

await new Publisher(source, S3Store.fromUrl("s3://tenant-a/hotel-1")).publish("production", releaseId);
```

```ts
import { CDSClient, MemoryStorage } from "@usecds/client";
import { S3Downloader } from "@usecds/s3/downloader";

const client = new CDSClient({
  storage: new MemoryStorage(),
  downloader: new S3Downloader({ endpoint: "https://s3.example.com", bucket: "tenant-a", prefix: "hotel-1", accessKeyId, secretAccessKey })
});
```

Permissions are the storage's: give the publisher read and write on the tenant's bucket, and each device group read on `<bucket>/<project>/*` only. See [docs/deployment.md](https://github.com/usecds/cds/blob/main/docs/deployment.md#s3-a-bucket-per-tenant-a-read-key-per-device-group).
