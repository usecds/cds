import { describe, it, expect } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";
import { Publisher, CollectionItem, ContentSource } from "../server/src/index.js";
import { CDSClient, MemoryStorage, RemoteDownloader } from "../client/src/index.js";
import { S3Store, S3Downloader } from "../s3/src/index.js";

type Stored = { body: Buffer; contentType?: string; cacheControl?: string };

// An in-memory S3: the commands S3Store sends, by name
function fakeS3() {
  const objects = new Map<string, Stored>();
  const missing = () => Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
  const at = (input: { Bucket: string; Key: string }) => `${input.Bucket}/${input.Key}`;
  const client = {
    puts: 0,
    async send(command: { constructor: { name: string }; input: any }) {
      const input = command.input;
      switch (command.constructor.name) {
        case "PutObjectCommand":
          client.puts++;
          objects.set(at(input), { body: Buffer.from(input.Body), contentType: input.ContentType, cacheControl: input.CacheControl });
          return {};
        case "HeadObjectCommand": {
          const o = objects.get(at(input));
          if (!o) throw missing();
          return { ContentLength: o.body.length };
        }
        case "GetObjectCommand": {
          const o = objects.get(at(input));
          if (!o) throw missing();
          return { Body: { transformToString: async () => o.body.toString("utf-8") } };
        }
        case "DeleteObjectCommand":
          objects.delete(at(input));
          return {};
        case "ListObjectsV2Command": {
          const base = `${input.Bucket}/`;
          const keys = [...objects.keys()].filter((k) => k.startsWith(base + input.Prefix)).map((k) => ({ Key: k.slice(base.length) }));
          return { Contents: keys, IsTruncated: false };
        }
      }
      throw new Error(`fake S3: ${command.constructor.name}`);
    }
  };
  return { objects, client };
}

// Reads what the fake holds under a prefix, the way a device would
function fakeDownloader(objects: Map<string, Stored>, base: string): RemoteDownloader {
  const read = (relative: string) => {
    const o = objects.get(`${base}/${relative}`);
    if (!o) throw new Error(`404 ${relative}`);
    return o.body;
  };
  return {
    fetchChannelManifest: async (channel) => ({ manifest: JSON.parse(read(`channels/${channel}/manifest.json`).toString()) }),
    fetchReleaseManifest: async (id) => JSON.parse(read(`releases/${id}.json`).toString()),
    fetchObject: async (hash) => read(`objects/${hash}.json`).toString("utf-8"),
    fetchMedia: async (hash, ext) => read(`media/${hash}${ext}`)
  };
}

const sourceOf = (text: string): ContentSource => ({
  getCollections: async (): Promise<Record<string, CollectionItem[]>> => ({
    snippets: [{ id: "s1", key: "contact-info", logo: "logo.png", media: ["logo.png"], translations: { en: { text } } }]
  }),
  getMedia: async () => [{ virtualPath: "logo.png", content: Buffer.from("png"), mimeType: "image/png" }]
});

describe("S3Store", () => {
  it("publishes into a bucket under the project's prefix, readable like a folder store", async () => {
    const { objects, client } = fakeS3();
    const store = new S3Store({ bucket: "tenant-a", prefix: "/hotel-1/", client: client as unknown as S3Client });
    await new Publisher(sourceOf("Call us"), store).publish("production", "r1");

    const keys = [...objects.keys()];
    expect(keys.every((k) => k.startsWith("tenant-a/hotel-1/"))).toBe(true);
    const channel = objects.get("tenant-a/hotel-1/channels/production/manifest.json")!;
    expect(channel.cacheControl).toBe("no-cache");
    const object = keys.find((k) => k.includes("/objects/"))!;
    expect(objects.get(object)).toMatchObject({ contentType: "application/json", cacheControl: "public, max-age=31536000, immutable" });
    expect(objects.get(keys.find((k) => k.endsWith(".png"))!)?.contentType).toBe("image/png");

    const device = new CDSClient({ storage: new MemoryStorage(), downloader: fakeDownloader(objects, "tenant-a/hotel-1") });
    await device.initialize();
    expect((await device.sync("production")).success).toBe(true);
    expect(device.useLocale("de").use("snippets").get("contact-info")?.text).toBe("Call us");
  });

  it("skips content it already has, and keeps retention and GC working", async () => {
    const { objects, client } = fakeS3();
    const store = new S3Store({ bucket: "tenant-a", prefix: "hotel-1", client: client as unknown as S3Client });
    const publish = (text: string, id: string) => new Publisher(sourceOf(text), store, { retentionCount: 1 }).publish("production", id);
    await publish("Call us", "r1");
    const puts = client.puts;
    await publish("Call us", "r2");
    // only the release and channel manifests are new
    expect(client.puts - puts).toBe(2);

    await publish("Call us now", "r3");
    expect(await store.listChannels()).toEqual(["production"]);
    expect((await store.readChannelManifest("production"))?.releaseId).toBe("r3");
    const releases = await store.listReleases();
    expect(releases).toContain("r3");
    expect(releases).not.toContain("r1");
    expect(await store.objectSize((await store.listObjects())[0]!)).toBeGreaterThan(0);
    expect(await store.readRelease("missing")).toBeNull();
  });

  it("reads s3://bucket/prefix", () => {
    const store = S3Store.fromUrl("s3://tenant-a/hotel-1", { endpoint: "http://localhost:8333", credentials: { accessKeyId: "k", secretAccessKey: "s" } });
    expect([store.bucket, store.prefix]).toEqual(["tenant-a", "hotel-1"]);
    expect(() => S3Store.fromUrl("/tmp/out")).toThrow(/Not an S3 URL/);
  });
});

// Against a real S3 server: a publisher key for the bucket, and a device group's read key for one
// prefix. E.g. the sandbox's SeaweedFS:
//   CDS_S3_TEST_ENDPOINT=http://localhost:8333 CDS_S3_TEST_BUCKET=tenant-demo
//   CDS_S3_TEST_PUBLISHER=publisher-tenant-demo:publisher-tenant-demo-secret
//   CDS_S3_TEST_READER=group-hotelplatform:group-hotelplatform-secret
//   CDS_S3_TEST_PREFIX=hotelplatform CDS_S3_TEST_OTHER_PREFIX=hotelautomation
const env = process.env;
const real = env.CDS_S3_TEST_ENDPOINT ? describe : describe.skip;

real("S3 store and downloader on a real server", () => {
  const keys = (pair = "") => {
    const [accessKeyId = "", secretAccessKey = ""] = pair.split(":");
    return { accessKeyId, secretAccessKey };
  };
  const run = `cds-test-${Date.now()}`;
  const endpoint = env.CDS_S3_TEST_ENDPOINT!;
  const bucket = env.CDS_S3_TEST_BUCKET!;
  const storeAt = (prefix: string) => new S3Store({ endpoint, bucket, prefix: `${prefix}/${run}`, credentials: keys(env.CDS_S3_TEST_PUBLISHER) });
  const deviceAt = (prefix: string) => {
    const downloader = new S3Downloader({ endpoint, bucket, prefix: `${prefix}/${run}`, ...keys(env.CDS_S3_TEST_READER) });
    return { downloader, client: new CDSClient({ storage: new MemoryStorage(), downloader }) };
  };

  it("syncs its own project with signed requests, answers 304 when unchanged, and refuses the other project", async () => {
    await new Publisher(sourceOf("Call us"), storeAt(env.CDS_S3_TEST_PREFIX!)).publish("production", "r1");
    await new Publisher(sourceOf("Not yours"), storeAt(env.CDS_S3_TEST_OTHER_PREFIX!)).publish("production", "r1");

    const own = deviceAt(env.CDS_S3_TEST_PREFIX!);
    await own.client.initialize();
    expect(await own.client.sync("production")).toMatchObject({ success: true, updated: true });
    expect(own.client.use("snippets").get("contact-info")?.translations.en.text).toBe("Call us");
    expect((await own.downloader.fetchChannelManifest("production")).notModified).toBe(true);

    const other = deviceAt(env.CDS_S3_TEST_OTHER_PREFIX!);
    await other.client.initialize();
    const result = await other.client.sync("production");
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/403/);
  });
});
