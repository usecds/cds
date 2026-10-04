#!/usr/bin/env node
// Publishes a Directus instance into a CDS store (GET requests only).
//
//   cds-directus-publish --config directus-source.json --out .cds/published
//                        [--mapping cds/mapping.ts] [--channel production] [--release <id>]
//                        [--targets targets/] [--report .cds/report]
//
// --mapping: a module whose default export (or `map`) maps the records to the CDS contract. It may
// also export `mediaPath`, `collections` (more to fetch, merged into the config), `optional` (collections
// that may be missing) and `targets` (checks, e.g. contentTypeTarget for declared content types).
// TypeScript modules work on Node 23.6+ (type stripping).
//
// The Directus URL and read token come from the config, or DIRECTUS_URL / DIRECTUS_API_TOKEN.
import fs from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";
import {
  Publisher,
  FilesystemStore,
  loadTargets,
  createPublishReport,
  renderPublishReportHtml,
  PublishRequirementsError,
  PublishArtifacts,
  ReleaseManifest,
  TargetDefinition
} from "@cds/server";
import { DirectusSource, DirectusSourceConfig } from "./source.js";

const args = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  return args[i].includes("=") ? args[i].slice(args[i].indexOf("=") + 1) : args[i + 1];
};

async function main() {
  const configPath = arg("config");
  const out = arg("out");
  if (!configPath || !out) {
    console.error("Usage: cds-directus-publish --config <file> --out <dir> [--mapping <module>] [--channel production] [--release <id>] [--targets <dir>] [--report <dir>]");
    process.exit(2);
  }
  const config: DirectusSourceConfig = JSON.parse(await fs.readFile(configPath, "utf-8"));
  config.url = process.env.DIRECTUS_URL ?? config.url;
  config.token = process.env.DIRECTUS_API_TOKEN ?? process.env.DIRECTUS_TOKEN ?? config.token;
  if (!config.url) throw new Error("No Directus URL: set DIRECTUS_URL or url in the config");

  const channel = arg("channel") ?? "production";
  // Release IDs sort chronologically: retention keeps the newest
  const releaseId = arg("release") ?? new Date().toISOString().replace(/[:.]/g, "-");
  const targetsDir = arg("targets");
  const reportDir = arg("report") ?? path.join(path.dirname(out), "report");

  let mappingTargets: TargetDefinition[] = [];
  const mappingPath = arg("mapping");
  if (mappingPath) {
    const mod = await import(pathToFileURL(path.resolve(mappingPath)).href);
    config.map = mod.map ?? mod.default;
    if (typeof config.map !== "function") throw new Error(`${mappingPath} exports no mapping function (default or map)`);
    if (typeof mod.mediaPath === "function") config.mediaPath = mod.mediaPath;
    // Collections the mapping needs fetched (e.g. derived from declared content types)
    if (mod.collections && typeof mod.collections === "object") config.collections = { ...mod.collections, ...config.collections };
    // Checks the mapping brings (e.g. a content types target)
    if (Array.isArray(mod.targets)) mappingTargets = mod.targets;
    if (Array.isArray(mod.optional)) config.optional = [...(config.optional ?? []), ...mod.optional];
  }

  const source = new DirectusSource({ ...config, log: (m) => console.log(`[directus] ${m}`) });
  const publisher = new Publisher(source, new FilesystemStore(out), { retentionCount: 5 });
  const fromDir = targetsDir ? await loadTargets(targetsDir) : undefined;
  const all = [...(fromDir ?? []), ...mappingTargets];
  const targets = all.length ? all : undefined;

  const writeReport = async (artifacts: PublishArtifacts, manifest?: ReleaseManifest, error?: Error) => {
    const report = createPublishReport({ channel, releaseId, artifacts, manifest, error });
    await fs.mkdir(reportDir, { recursive: true });
    await fs.writeFile(path.join(reportDir, "report.json"), JSON.stringify(report, null, 2) + "\n", "utf-8");
    await fs.writeFile(path.join(reportDir, "index.html"), renderPublishReportHtml(report), "utf-8");
    // The source map has internal IDs and admin links: pipeline output, next to the report
    if (artifacts.sourceMap) {
      await fs.writeFile(path.join(reportDir, "source-map.json"), JSON.stringify(artifacts.sourceMap, null, 2) + "\n", "utf-8");
    }
    console.log(`[cds] report: ${path.join(reportDir, "index.html")} (${report.summary.requirements} failed requirements, ${report.summary.recommendations} recommendations, ${report.summary.warnings} warnings)`);
  };

  try {
    const { manifest, artifacts } = await publisher.publish(channel, releaseId, { targets });
    console.log(`[cds] published ${releaseId} to channel ${channel}: ${Object.keys(manifest.collections).length} collections, ${Object.keys(manifest.media).length} media files -> ${out}`);
    await writeReport(artifacts, manifest);
  } catch (err) {
    if (err instanceof PublishRequirementsError) await writeReport(err.artifacts, undefined, err);
    throw err;
  }
}

main().catch((err) => {
  console.error("[cds] publish failed:", err instanceof Error ? (process.env.DEBUG ? err.stack : err.message) : err);
  process.exit(1);
});
