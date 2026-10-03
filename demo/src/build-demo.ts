import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Server imports
import { 
  Publisher, 
  FixtureSource, 
  FilesystemStore 
} from "@cds/server";

// Client imports
import { 
  CDSClient, 
  FilesystemStorage, 
  RemoteDownloader, 
  ChannelManifest, 
  ReleaseManifest 
} from "@cds/client";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

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
  console.log("🚀 Starting CDS Demo Builder...");

  const publishedDir = path.join(rootDir, "published");
  const cacheDir = path.join(rootDir, "cache");
  const distDir = path.join(rootDir, "dist");

  // Clean intermediate folders to start fresh
  await fs.rm(publishedDir, { recursive: true, force: true });
  await fs.rm(cacheDir, { recursive: true, force: true });
  await fs.rm(distDir, { recursive: true, force: true });
  await fs.mkdir(distDir, { recursive: true });

  // -------------------------------------------------------------
  // 1. SERVER-SIDE: Normalizing & Publishing Content
  // -------------------------------------------------------------
  console.log("📂 [Server] Loading raw JSON collections from data directory...");
  const dataDir = path.join(rootDir, "data");
  const site_settings = JSON.parse(await fs.readFile(path.join(dataDir, "site_settings.json"), "utf-8"));
  const featuresData = JSON.parse(await fs.readFile(path.join(dataDir, "features.json"), "utf-8"));
  const goalsData = JSON.parse(await fs.readFile(path.join(dataDir, "goals.json"), "utf-8"));
  const testimonialsData = JSON.parse(await fs.readFile(path.join(dataDir, "testimonials.json"), "utf-8"));

  const collections = {
    site_settings,
    features: featuresData,
    goals: goalsData,
    testimonials: testimonialsData
  };

  console.log("📦 [Server] Setting up Source & Storage target...");
  const source = new FixtureSource(collections, []);
  const serverStore = new FilesystemStore(publishedDir);
  const publisher = new Publisher(source, serverStore, { retentionCount: 3 });

  console.log("📝 [Server] Publishing content release to simulated CDN storage...");
  const releaseId = `release_demo_${Date.now()}`;
  const { artifacts } = await publisher.publish("demo-channel", releaseId, { sourceLocale: "en" });
  console.log(`✅ [Server] Published successfully: ${releaseId}`);
  for (const [locale, counts] of Object.entries(artifacts.translations.locales)) {
    console.log(`🌐 [Server] Translations ${locale}: ${counts.translated}/${counts.expected} (missing ${counts.missing}, stale ${counts.stale})`);
  }

  // -------------------------------------------------------------
  // 2. CLIENT-SIDE: Syncing Content from simulated CDN
  // -------------------------------------------------------------
  console.log("⚡ [Client] Initializing client caching storage...");
  const clientStorage = new FilesystemStorage(cacheDir);
  const downloader = new DemoLocalDownloader(publishedDir);
  const client = new CDSClient({
    storage: clientStorage,
    downloader
  });

  await client.initialize();

  console.log("🔄 [Client] Checking and synchronizing with 'demo-channel' channel...");
  const syncResult = await client.sync("demo-channel");
  if (!syncResult.success) {
    throw new Error(`Client synchronization failed: ${syncResult.error?.message}`);
  }
  console.log(`✅ [Client] Synced and activated release: ${syncResult.releaseId}`);

  // -------------------------------------------------------------
  // 3. GENERATOR-SIDE: Querying Local Cache and Rendering HTML Page
  // -------------------------------------------------------------
  console.log("🎨 [Generator] Querying CDS Client APIs & generating multilingual single page website...");
  
  const locales = client.getLocales();
  console.log(`🌍 Available Locales: ${locales.join(", ")}`);

  for (const locale of locales) {
    // Query homepage settings
    const settingsItem = await client.getItemByKey("site_settings", "homepage");
    if (!settingsItem) throw new Error("Site settings item not found in CDS cache!");

    const content = settingsItem.translations[locale];
    const features = await client.getCollection("features");
    const goals = await client.getCollection("goals");
    const testimonials = await client.getCollection("testimonials");

    // Generate responsive Tailwind layout
    const html = `<!DOCTYPE html>
<html lang="${locale}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${content.siteTitle}</title>
    <!-- Tailwind CSS -->
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body {
            font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        }
        .code-font {
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        }
    </style>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen selection:bg-teal-500 selection:text-slate-900">

    <!-- Language Selector Nav -->
    <header class="border-b border-slate-800 bg-slate-950/80 backdrop-blur-md sticky top-0 z-50">
        <div class="max-w-6xl mx-auto px-6 py-4 flex justify-between items-center">
            <div class="flex items-center space-x-3">
                <div class="w-8 h-8 rounded-lg bg-gradient-to-tr from-teal-500 to-blue-600 flex items-center justify-center font-bold text-slate-950">
                    C
                </div>
                <span class="font-extrabold text-xl tracking-tight bg-gradient-to-r from-teal-400 to-blue-500 bg-clip-text text-transparent">CDS</span>
            </div>
            
            <nav class="flex items-center space-x-2">
                <a href="index.html" class="px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${locale === 'en' ? 'bg-teal-500/10 text-teal-400 border border-teal-500/20' : 'text-slate-400 hover:text-slate-200'}">EN (English)</a>
                <a href="index-de.html" class="px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${locale === 'de' ? 'bg-teal-500/10 text-teal-400 border border-teal-500/20' : 'text-slate-400 hover:text-slate-200'}">DE (Deutsch)</a>
            </nav>
        </div>
    </header>

    <!-- Hero Section -->
    <section class="relative overflow-hidden py-24 lg:py-32 border-b border-slate-900 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-teal-950/20 via-slate-950 to-slate-950">
        <div class="absolute inset-0 bg-[linear-gradient(to_right,#0f172a_1px,transparent_1px),linear-gradient(to_bottom,#0f172a_1px,transparent_1px)] bg-[size:4rem_4rem] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,#000_70%,transparent_100%)]"></div>
        
        <div class="max-w-4xl mx-auto text-center px-6 relative z-10">
            <span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold bg-teal-500/10 text-teal-400 border border-teal-500/20 mb-6">
                Active Release: ${syncResult.releaseId} (Atomic & Live)
            </span>
            <h1 class="text-4xl sm:text-6xl font-extrabold tracking-tight text-white mb-6 leading-tight">
                ${content.heroTitle}
            </h1>
            <p class="text-lg sm:text-xl text-slate-400 max-w-2xl mx-auto mb-10 leading-relaxed">
                ${content.heroSubtitle}
            </p>
            <div class="flex flex-col sm:flex-row justify-center items-center gap-4">
                <a href="#goals" class="w-full sm:w-auto px-8 py-3.5 rounded-xl font-semibold bg-gradient-to-r from-teal-500 to-blue-600 hover:from-teal-400 hover:to-blue-500 text-slate-950 shadow-lg shadow-teal-500/20 transition-all text-center">
                    ${content.ctaPrimary}
                </a>
                <a href="https://github.com/anomalyco/opencode" target="_blank" class="w-full sm:w-auto px-8 py-3.5 rounded-xl font-semibold bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 hover:border-slate-700 transition-all text-center">
                    ${content.ctaSecondary}
                </a>
            </div>
        </div>
    </section>

    <!-- Architecture Diagram Section -->
    <section class="py-20 bg-slate-950 border-b border-slate-900">
        <div class="max-w-6xl mx-auto px-6">
            <div class="text-center mb-16">
                <h2 class="text-3xl font-bold text-white mb-4">
                    ${locale === 'en' ? 'How CDS Works' : 'Wie CDS funktioniert'}
                </h2>
                <p class="text-slate-400 max-w-xl mx-auto">
                    ${locale === 'en' 
                      ? 'CDS acts as a decoupled static compiler between authoring tools and consumer applications.' 
                      : 'CDS fungiert als entkoppelter statischer Compiler zwischen Autorenwerkzeugen und Client-Anwendungen.'}
                </p>
            </div>
            
            <div class="grid grid-cols-1 md:grid-cols-5 gap-4 items-center bg-slate-900/40 p-8 rounded-3xl border border-slate-800">
                <div class="bg-slate-900 p-6 rounded-2xl border border-slate-800 text-center">
                    <span class="text-3xl">✍️</span>
                    <h3 class="font-bold text-white mt-3 mb-1">1. CMS</h3>
                    <p class="text-xs text-slate-400">Directus / Headless CMS</p>
                </div>
                <div class="text-center text-teal-500 font-bold rotate-90 md:rotate-0">➔</div>
                <div class="bg-gradient-to-b from-teal-950/40 to-blue-950/40 p-6 rounded-2xl border border-teal-500/30 text-center relative">
                    <div class="absolute -top-3 left-1/2 -translate-x-1/2 bg-teal-500 text-slate-950 text-[10px] uppercase font-bold px-2 py-0.5 rounded">CDS Server</div>
                    <span class="text-3xl">⚙️</span>
                    <h3 class="font-bold text-teal-400 mt-3 mb-1">2. Normalize</h3>
                    <p class="text-xs text-slate-300">Determinism, Hashing, GC</p>
                </div>
                <div class="text-center text-teal-500 font-bold rotate-90 md:rotate-0">➔</div>
                <div class="bg-slate-900 p-6 rounded-2xl border border-slate-800 text-center">
                    <span class="text-3xl">📱</span>
                    <h3 class="font-bold text-white mt-3 mb-1">3. CDS Client</h3>
                    <p class="text-xs text-slate-400">Offline Cache & Sync SDK</p>
                </div>
            </div>
        </div>
    </section>

    <!-- Features Section -->
    <section class="py-20 bg-slate-950/50 border-b border-slate-900">
        <div class="max-w-6xl mx-auto px-6">
            <div class="text-center mb-16">
                <h2 class="text-3xl font-bold text-white mb-4">
                    ${locale === 'en' ? 'Core Capabilities' : 'Kernfunktionen'}
                </h2>
                <p class="text-slate-400 max-w-xl mx-auto">
                    ${locale === 'en'
                      ? 'Engineered for reliability, ultra-low latency, and absolute independent client delivery.'
                      : 'Entwickelt für Ausfallsicherheit, extrem niedrige Latenzzeiten und völlig unabhängige Bereitstellung.'}
                </p>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
                ${features.map(feat => {
                  const translation = feat.translations[locale];
                  return `
                  <div class="p-8 rounded-2xl bg-slate-900/50 border border-slate-800 hover:border-slate-700 transition-colors">
                      <h3 class="text-xl font-bold text-teal-400 mb-3">${translation.title}</h3>
                      <p class="text-slate-400 leading-relaxed text-sm">${translation.description}</p>
                  </div>
                  `;
                }).join("")}
            </div>
        </div>
    </section>

    <!-- Goals Section (Query list) -->
    <section id="goals" class="py-20 bg-slate-950 border-b border-slate-900">
        <div class="max-w-6xl mx-auto px-6">
            <div class="text-center mb-16">
                <h2 class="text-3xl font-bold text-white mb-4">
                    ${locale === 'en' ? 'Design Principles' : 'Projektziele'}
                </h2>
                <p class="text-slate-400 max-w-xl mx-auto">
                    ${locale === 'en' 
                      ? 'CDS aims to revolutionize static asset pipelines for edge applications.' 
                      : 'CDS revolutioniert statische Asset-Pipelines für Edge-Anwendungen.'}
                </p>
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
                ${goals.map(goal => {
                  const translation = goal.translations[locale];
                  return `
                  <div class="p-6 rounded-2xl bg-slate-900 border border-slate-800/60 flex flex-col items-center text-center">
                      <span class="text-4xl mb-4">${translation.icon || '🎯'}</span>
                      <h4 class="font-semibold text-white text-base leading-snug">${translation.title}</h4>
                  </div>
                  `;
                }).join("")}
            </div>
        </div>
    </section>

    <!-- Testimonials Section -->
    <section class="py-20 bg-slate-950/50 border-b border-slate-900">
        <div class="max-w-6xl mx-auto px-6">
            <div class="text-center mb-16">
                <h2 class="text-3xl font-bold text-white mb-4">
                    ${locale === 'en' ? 'What Integrators Say' : 'Was Entwickler sagen'}
                </h2>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
                ${testimonials.map(test => {
                  const translation = test.translations[locale];
                  return `
                  <div class="p-8 rounded-2xl bg-slate-900/30 border border-slate-800/80 italic flex flex-col justify-between">
                      <p class="text-slate-300 text-lg mb-6 leading-relaxed">
                          "${translation.quote}"
                      </p>
                      <div class="flex items-center space-x-3 not-italic">
                          <div class="w-10 h-10 rounded-full bg-slate-800 flex items-center justify-center font-bold text-teal-400">
                              ${translation.author[0]}
                          </div>
                          <div>
                              <div class="font-bold text-white text-sm">${translation.author}</div>
                              <div class="text-xs text-slate-500">${translation.role}</div>
                          </div>
                      </div>
                  </div>
                  `;
                }).join("")}
            </div>
        </div>
    </section>

    <!-- Interactive Client Live Cache Log section (Great for proving client storage) -->
    <section class="py-20 bg-slate-950">
        <div class="max-w-4xl mx-auto px-6">
            <div class="bg-slate-900 rounded-3xl border border-slate-800 p-8 shadow-2xl relative overflow-hidden">
                <div class="absolute top-0 right-0 w-32 h-32 bg-teal-500/10 rounded-full blur-2xl"></div>
                <div class="flex items-center space-x-3 mb-6 border-b border-slate-800 pb-4">
                    <div class="flex space-x-1.5">
                        <div class="w-3 h-3 rounded-full bg-red-500/40"></div>
                        <div class="w-3 h-3 rounded-full bg-yellow-500/40"></div>
                        <div class="w-3 h-3 rounded-full bg-green-500/40"></div>
                    </div>
                    <span class="text-xs code-font text-slate-400">cds-client-logger --active-cache</span>
                </div>
                <h3 class="text-lg font-bold text-white mb-3">
                    ${locale === 'en' ? 'Local Staged Release Log' : 'Lokaler Release-Cache-Status'}
                </h3>
                <p class="text-slate-400 text-sm mb-6 leading-relaxed">
                    ${locale === 'en'
                      ? 'The client loaded the static release schema dynamically. Here is the active localized map cached locally in FilesystemStorage:'
                      : 'Der Client hat das statische Release-Schema dynamisch geladen. Hier ist die lokal im Filesystem-Cache gespeicherte Struktur:'}
                </p>
                <pre class="bg-slate-950 p-4 rounded-xl text-xs code-font text-teal-400 overflow-x-auto border border-slate-800"><code>${JSON.stringify({
                  activeReleaseId: syncResult.releaseId,
                  schemaVersion: 1,
                  loadedCollections: client.getCollectionsList(),
                  syncedLocales: client.getLocales(),
                  cachingStorageAdapter: "FilesystemStorage"
                }, null, 2)}</code></pre>
            </div>
        </div>
    </section>

    <!-- Footer -->
    <footer class="py-12 border-t border-slate-900 bg-slate-950">
        <div class="max-w-6xl mx-auto px-6 text-center text-sm text-slate-500">
            <p>${content.footerText}</p>
        </div>
    </footer>

</body>
</html>`;

    const outFilename = locale === "en" ? "index.html" : `index-${locale}.html`;
    const outPath = path.join(distDir, outFilename);
    await fs.writeFile(outPath, html, "utf-8");
    console.log(`🌍 [Generator] Rendered and wrote ${outFilename} to: ${outPath}`);
  }

  console.log("🎉 CDS Demo Website generated successfully under demo/dist/");
}

run().catch((err) => {
  console.error("❌ Demo build failed:", err);
  process.exit(1);
});
