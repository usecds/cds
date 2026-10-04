import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Server imports
import {
  Publisher,
  FixtureSource,
  FilesystemStore,
  loadTargets,
  createPublishReport,
  renderPublishReportHtml,
  PublishRequirementsError,
  PublishArtifacts,
  ReleaseManifest as PublishedManifest
} from "@cds/server";

// Client imports
import {
  CDSClient,
  FilesystemStorage,
  RemoteDownloader,
  ChannelManifest,
  ReleaseManifest
} from "@cds/client";

import { VariantCache } from "@cds/imaging";
import { createImageRenderer } from "./images.js";
import { renderAllPages, llmsFromPages, buildSitemap, redirectPage } from "./outputs.js";
import { localHref, outputFile } from "./paths.js";
import { SITE_URL } from "./site.js";
import { startServer } from "./server.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const CHANNEL = "demo-channel";

// Generator mode: "static" (default) writes files to dist/; "hono" serves the routes with Hono (SSR);
// "images" pre-generates every image variant into the server's cache (demo/cache-site/media) and exits
// Accepts both --name=value and --name value
const arg = (name: string): string | undefined => {
  const args = process.argv.slice(2);
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  return args[i].includes("=") ? args[i].slice(args[i].indexOf("=") + 1) : args[i + 1];
};
const MODE = arg("mode") ?? "static";
const PORT = Number(arg("port") ?? 3000);
if (MODE !== "static" && MODE !== "hono" && MODE !== "images") {
  console.error(`Unknown --mode=${MODE}; use static (default), hono or images`);
  process.exit(1);
}

// Custom Downloader for client to read from our Published target
class DemoLocalDownloader implements RemoteDownloader {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  async fetchChannelManifest(channel: string, currentEtag?: string): Promise<{ manifest: ChannelManifest; etag?: string; notModified?: boolean }> {
    const filePath = path.join(this.baseDir, "channels", channel, "manifest.json");
    if (!existsSync(filePath)) {
      throw new Error(`Demo Remote channel manifest not found: ${filePath}`);
    }
    const content = await fs.readFile(filePath, "utf-8");
    const manifest = JSON.parse(content);
    if (currentEtag && currentEtag === manifest.releaseId) {
      return { manifest, etag: manifest.releaseId, notModified: true };
    }
    return { manifest, etag: manifest.releaseId, notModified: false };
  }

  async fetchReleaseManifest(releaseId: string): Promise<ReleaseManifest> {
    const filePath = path.join(this.baseDir, "releases", `${releaseId}.json`);
    if (!existsSync(filePath)) {
      throw new Error(`Demo Remote release manifest not found: ${filePath}`);
    }
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content);
  }

  async fetchObject(hash: string): Promise<string> {
    const filePath = path.join(this.baseDir, "objects", `${hash}.json`);
    if (!existsSync(filePath)) {
      throw new Error(`Demo Remote object not found: ${filePath}`);
    }
    return await fs.readFile(filePath, "utf-8");
  }

  async fetchMedia(hash: string, ext: string): Promise<Buffer> {
    const filePath = path.join(this.baseDir, "media", `${hash}${ext}`);
    if (!existsSync(filePath)) {
      throw new Error(`Demo Remote media not found: ${filePath}`);
    }
    return await fs.readFile(filePath);
  }
}

async function run() {
  console.log(`🚀 Starting CDS Demo Builder (mode: ${MODE})...`);

  // Each mode has its own published store and client cache, so a static build doesn't pull files
  // from under a running server. The server's image cache (cache-site) is shared on purpose.
  const workDir = path.join(rootDir, ".work", MODE);
  const publishedDir = path.join(workDir, "published");
  const cacheDir = path.join(workDir, "cache");
  const distDir = path.join(rootDir, "dist");
  const reportsDir = path.join(rootDir, "reports");
  const serverMediaDir = path.join(rootDir, "cache-site", "media");

  // Clean intermediate folders to start fresh. The server's image cache (demo/cache-site) is kept:
  // its variants are keyed by content, so they stay valid across runs.
  for (const dir of [publishedDir, reportsDir, cacheDir, ...(MODE === "static" ? [distDir] : [])]) {
    await fs.rm(dir, { recursive: true, force: true });
  }

  // -------------------------------------------------------------
  // 1. SERVER-SIDE: Normalizing & Publishing Content
  // -------------------------------------------------------------
  console.log("📂 [Server] Loading raw JSON collections from data directory...");
  const dataDir = path.join(rootDir, "data");
  // Every JSON file in data/ is a collection named after the file (site structure and media included)
  const collections: Record<string, any[]> = {};
  for (const file of (await fs.readdir(dataDir)).filter((f) => f.endsWith(".json")).sort()) {
    collections[path.basename(file, ".json")] = JSON.parse(await fs.readFile(path.join(dataDir, file), "utf-8"));
  }

  // Media files from data/media; their alt texts, descriptions and focal points live in _media.json
  const mimeTypes: Record<string, string> = { ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg" };
  const mediaDir = path.join(dataDir, "media");
  const media = await Promise.all(
    (await fs.readdir(mediaDir)).map(async (file) => ({
      virtualPath: file,
      content: await fs.readFile(path.join(mediaDir, file)),
      mimeType: mimeTypes[path.extname(file)] ?? "application/octet-stream"
    }))
  );

  console.log("📦 [Server] Setting up Source & Storage target...");
  const source = new FixtureSource(collections, media);
  const serverStore = new FilesystemStore(publishedDir);
  const publisher = new Publisher(source, serverStore, { retentionCount: 3 });

  console.log("📝 [Server] Publishing content release to simulated CDN storage...");
  const releaseId = `release_demo_${Date.now()}`;
  const targets = await loadTargets(path.join(rootDir, "targets"));

  // The publish report (translations, missing alt texts, target checks, warnings) is pipeline output:
  // written next to the build as report.json + index.html, never published. Also written on failure.
  const writeReport = async (artifacts: PublishArtifacts, manifest?: PublishedManifest, error?: Error) => {
    const report = createPublishReport({ channel: CHANNEL, releaseId, artifacts, manifest, error });
    await fs.mkdir(reportsDir, { recursive: true });
    await fs.writeFile(path.join(reportsDir, "report.json"), JSON.stringify(report, null, 2) + "\n", "utf-8");
    await fs.writeFile(path.join(reportsDir, "index.html"), renderPublishReportHtml(report), "utf-8");
    console.log(`📋 [Server] Publish report: ${path.join(reportsDir, "index.html")}`);
  };

  let artifacts: PublishArtifacts;
  try {
    const result = await publisher.publish(CHANNEL, releaseId, { sourceLocale: "en", targets });
    artifacts = result.artifacts;
    console.log(`✅ [Server] Published successfully: ${releaseId}`);
    await writeReport(artifacts, result.manifest);
  } catch (err) {
    if (err instanceof PublishRequirementsError) await writeReport(err.artifacts, undefined, err);
    throw err;
  }

  // -------------------------------------------------------------
  // 2. CLIENT-SIDE: Syncing Content from simulated CDN
  // -------------------------------------------------------------
  console.log("⚡ [Client] Initializing client caching storage...");
  const client = new CDSClient({
    storage: new FilesystemStorage(cacheDir),
    downloader: new DemoLocalDownloader(publishedDir),
    target: "landing-page"
  });
  await client.initialize();

  console.log(`🔄 [Client] Checking and synchronizing with '${CHANNEL}' channel...`);
  const syncResult = await client.sync(CHANNEL);
  if (!syncResult.success) {
    throw new Error(`Client synchronization failed: ${syncResult.error?.message}`);
  }
  console.log(`✅ [Client] Synced and activated release: ${syncResult.releaseId}`);

  // Image sizes per breakpoint come from the landing-page target (the image processor's contract)
  const contract = artifacts.targets["landing-page"].media!;

  // -------------------------------------------------------------
  // 3a. HONO MODE: serve the routes from _routes, rendered per request
  // -------------------------------------------------------------
  if (MODE === "hono") {
    // Lazy: pages only plan variants; each one is rendered on its first request
    const cache = await VariantCache.open(serverMediaDir, { persist: true });
    const renderer = createImageRenderer(client, cache, contract, { eager: false });
    startServer({ client, renderer, contract, port: PORT, channel: CHANNEL, syncIntervalMs: 30_000 });
    return;
  }

  // -------------------------------------------------------------
  // 3b. IMAGES MODE: pre-generate every variant into the server's cache, then exit
  // -------------------------------------------------------------
  if (MODE === "images") {
    console.log(`🖼️  [Imaging] Pre-generating every image variant into ${serverMediaDir}...`);
    const cache = await VariantCache.open(serverMediaDir, { persist: true });
    const renderer = createImageRenderer(client, cache, contract, { eager: true });
    await renderAllPages(client, renderer, contract, "server");
    const { stats } = renderer;
    console.log(`🖼️  [Imaging] ${stats.rendered} variants rendered, ${stats.reused} already cached, ${stats.skipped} high-DPR sizes skipped (source too small), ${stats.vector} vector images stored`);
    return;
  }

  // -------------------------------------------------------------
  // 3c. STATIC MODE: one file per route and language, relative links
  // -------------------------------------------------------------
  console.log("🎨 [Generator] Rendering every route from _routes / _pages / _blocks...");
  // Eager: every variant is rendered into dist/media while its page is rendered (no index: public output)
  const cache = await VariantCache.open(path.join(distDir, "media"), { persist: false });
  const renderer = createImageRenderer(client, cache, contract, { eager: true });

  const pages = await renderAllPages(client, renderer, contract, "static");
  for (const page of pages) {
    const file = path.join(distDir, outputFile(page.path));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, page.html, "utf-8");
    console.log(`🌍 [Generator] ${page.locale} ${page.path} -> ${outputFile(page.path)}`);
  }

  // Redirect routes: static hosts can't send a 301, so write a forwarding page
  for (const route of client.getRoutes().filter((r) => r.redirect)) {
    for (const [locale, routePath] of Object.entries(route.paths)) {
      const resolved = await client.resolveRoute(routePath);
      if (!resolved?.redirect) continue;
      const file = path.join(distDir, outputFile(routePath));
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, redirectPage(localHref(routePath, resolved.redirect.path), SITE_URL + resolved.redirect.path), "utf-8");
      console.log(`↪️  [Generator] ${locale} ${routePath} -> ${resolved.redirect.path}`);
    }
  }

  // llms.txt and sitemap.xml from the same routes
  const llms = await llmsFromPages(client, pages);
  await fs.writeFile(path.join(distDir, "llms.txt"), llms, "utf-8");
  await fs.writeFile(path.join(distDir, "sitemap.xml"), buildSitemap(client), "utf-8");
  console.log(`🤖 [Generator] Wrote llms.txt (${(Buffer.byteLength(llms) / 1024).toFixed(1)} KB) and sitemap.xml`);

  const { stats } = renderer;
  console.log(`🖼️  [Imaging] ${stats.rendered} variants rendered, ${stats.reused} reused, ${stats.skipped} high-DPR sizes skipped (source too small), ${stats.vector} vector images passed through`);
  console.log("🎉 CDS Demo Website generated successfully under demo/dist/");
}

run().catch((err) => {
  console.error("❌ Demo build failed:", err);
  process.exit(1);
});
