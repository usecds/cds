#!/usr/bin/env node
// Publishes a Directus instance into a CDS store (GET requests only).
//
//   cds-directus-publish --config directus-source.json --out .cds/published
//                        [--mapping cds/mapping.ts] [--channel production] [--release <id>]
//                        [--targets targets/] [--report .cds/report] [--scope <project id>]
//
// --mapping: a module whose default export (or `map`) maps the records to the CDS contract. It may
// also export `mediaPath`, `collections` (more to fetch, merged into the config), `optional` (collections
// that may be missing), `targets` (checks, e.g. contentTypeTarget for declared content types) and
// `scope` (paths to the scope's key per collection, and shared collections; merged with the config's).
//
// --scope (or DIRECTUS_SCOPE): publish only this scope's records (e.g. one project of a token that
// can read several). Every fetched collection then needs a scope path or must be declared shared.
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
} from "@usecds/server";
import { DirectusSource, DirectusSourceConfig, DirectusScope } from "./source.js";

// A scope as configured: the paths and shared collections, the value from --scope
type ScopeConfig = Partial<DirectusScope>;

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
    console.error("Usage: cds-directus-publish --config <file> --out <dir> [--mapping <module>] [--channel production] [--release <id>] [--targets <dir>] [--report <dir>] [--scope <value>]");
    process.exit(2);
  }
  const config: Omit<DirectusSourceConfig, "scope"> & { scope?: ScopeConfig } = JSON.parse(await fs.readFile(configPath, "utf-8"));
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
    // Scope paths the mapping knows (e.g. from the collections it declares)
    if (mod.scope && typeof mod.scope === "object") {
      const own: ScopeConfig = config.scope ?? {};
      config.scope = {
        ...own,
        paths: { ...mod.scope.paths, ...own.paths },
        shared: [...new Set([...(mod.scope.shared ?? []), ...(own.shared ?? [])])]
      };
    }
  }

  const scopeValue = arg("scope") ?? process.env.DIRECTUS_SCOPE ?? config.scope?.value;
  // Paths without a value: the token's permissions alone decide what is published
  const scope: DirectusScope | undefined = scopeValue ? { paths: {}, ...config.scope, value: scopeValue } : undefined;
  if (scope) console.log(`[directus] scope ${scope.value}`);

  const source = new DirectusSource({ ...config, scope, log: (m) => console.log(`[directus] ${m}`) });
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
