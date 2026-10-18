import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { build } from "esbuild";
import { Publisher } from "../server/dist/index.js";
import { S3Store } from "../s3/dist/store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const work = path.join(here, ".work");
// The AWS SDK is a dependency of @usecds/s3, not of the workspace root
const { S3Client, PutBucketCorsCommand } = createRequire(path.join(here, "..", "s3", "package.json"))("@aws-sdk/client-s3") as typeof import("@aws-sdk/client-s3");

const keyPair = (value: string) => {
  const [accessKeyId, secretAccessKey] = value.split(":");
  return { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! };
};

// Publishes a fresh release, lets pages read the bucket from other origins (CORS, GET only), and
// bundles the page from the client's and S3Downloader's sources
export default async function globalSetup() {
  const env = (name: string) => {
    const value = process.env[`CDS_S3_TEST_${name}`];
    if (!value) throw new Error(`CDS_S3_TEST_${name} is not set (see e2e/README.md)`);
    return value;
  };
  const endpoint = env("ENDPOINT");
  const bucket = env("BUCKET");
  const prefix = `${env("PREFIX")}/e2e-g12`;
  const publisher = keyPair(env("PUBLISHER"));
  const releaseId = `e2e-${new Date().toISOString().replace(/[^0-9]/g, "")}`;

  await new Publisher({
    getCollections: async () => ({
      snippets: [{ id: "s_welcome", key: "welcome", translations: { en: { text: "Grüße aus Zürich 🏨" } }, media: ["logo.png"] }]
    }),
    getMedia: async () => [{ virtualPath: "logo.png", content: Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 7) % 256)), mimeType: "image/png" }]
  }, new S3Store({ bucket, prefix, endpoint, credentials: publisher })).publish("production", releaseId);

  await new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true, credentials: publisher }).send(new PutBucketCorsCommand({
    Bucket: bucket,
    CORSConfiguration: { CORSRules: [{ AllowedOrigins: ["*"], AllowedMethods: ["GET", "HEAD"], AllowedHeaders: ["*"], ExposeHeaders: ["ETag"], MaxAgeSeconds: 600 }] }
  }));

  await fs.mkdir(work, { recursive: true });
  await build({
    entryPoints: [path.join(here, "app", "main.ts")],
    outfile: path.join(work, "main.js"),
    bundle: true,
    platform: "browser",
    format: "esm",
    alias: { "@usecds/client": path.join(here, "..", "client", "src", "browser.ts") },
    logLevel: "warning"
  });
  await fs.writeFile(path.join(work, "config.json"), JSON.stringify({
    channel: "production",
    releaseId,
    s3: { endpoint, bucket, prefix, ...keyPair(env("READER")) }
  }));
}
