import { ReleaseManifest, TranslationCounts } from "../types.js";
import { ContentIssue, TargetResult } from "./content-report.js";
import { PublishArtifacts } from "./publisher.js";
import { SourceLocaleOrigin } from "./translations.js";

// Publish report: pipeline output for editors and CI, written next to the build, never published
export interface PublishReport {
  schemaVersion: 1;
  status: "published" | "failed";
  channel: string;
  releaseId: string;
  createdAt: string;
  error?: string; // why the publish failed
  summary: {
    requirements: number; // failed requirements (any > 0 means the publish failed)
    recommendations: number;
    warnings: number;
    targets: { satisfied: number; total: number };
    translations: TranslationCounts; // overall, across all target locales
  };
  release?: { collections: number; items: number; media: number }; // absent when the publish failed
  targets: Record<string, TargetResult>;
  translations: {
    sourceLocale: string;
    sourceLocaleOrigin: SourceLocaleOrigin;
    locales: Record<string, TranslationCounts>;
    collections: Record<string, Record<string, TranslationCounts>>;
    itemsWithoutSource: { collection: string; id: string }[];
  };
  issues: ContentIssue[]; // requirements first, then by collection, item, locale, field
  warnings: string[];
}

/**
 * Builds the report for a publish run, successful (with manifest) or failed (with error).
 */
export function createPublishReport(input: {
  channel: string;
  releaseId: string;
  artifacts: PublishArtifacts;
  manifest?: ReleaseManifest;
  error?: Error;
}): PublishReport {
  const { content, translations } = input.artifacts;
  const severityOrder = { requirement: 0, recommendation: 1 };
  const issues = [...content.issues].sort((a, b) =>
    severityOrder[a.severity] - severityOrder[b.severity] ||
    (a.collection ?? "").localeCompare(b.collection ?? "") ||
    (a.id ?? "").localeCompare(b.id ?? "") ||
    (a.locale ?? "").localeCompare(b.locale ?? "") ||
    (a.field ?? "").localeCompare(b.field ?? "")
  );
  const targets = Object.values(content.targets);

  return {
    schemaVersion: 1,
    status: input.manifest ? "published" : "failed",
    channel: input.channel,
    releaseId: input.releaseId,
    createdAt: new Date().toISOString(),
    ...(input.error ? { error: input.error.message } : {}),
    summary: {
      requirements: issues.filter((i) => i.severity === "requirement").length,
      recommendations: issues.filter((i) => i.severity === "recommendation").length,
      warnings: content.warnings.length,
      targets: { satisfied: targets.filter((t) => t.satisfied).length, total: targets.length },
      translations: translations.overall
    },
    ...(input.manifest
      ? {
          release: {
            collections: Object.keys(input.manifest.collections).length,
            items: Object.values(input.manifest.collections).reduce((n, c) => n + c.itemCount, 0),
            media: Object.keys(input.manifest.media).length
          }
        }
      : {}),
    targets: content.targets,
    translations: {
      sourceLocale: translations.sourceLocale,
      sourceLocaleOrigin: translations.sourceLocaleOrigin,
      locales: translations.locales,
      collections: translations.collections,
      itemsWithoutSource: translations.itemsWithoutSource
    },
    issues,
    warnings: content.warnings
  };
}

const escape = (value: unknown) =>
  String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const percent = (c: TranslationCounts) => (c.expected === 0 ? "–" : `${Math.floor((c.translated / c.expected) * 1000) / 10}%`);

/**
 * Renders a report as a self-contained HTML page (no external resources, works offline).
 */
export function renderPublishReportHtml(report: PublishReport): string {
  const s = report.summary;
  const locales = Object.keys(report.translations.locales);
  const card = (label: string, value: string, tone = "") => `<div class="card ${tone}"><div class="value">${value}</div><div class="label">${label}</div></div>`;

  const targetRows = Object.entries(report.targets).map(([id, t]) =>
    `<tr><td><code>${escape(id)}</code></td><td><span class="badge ${t.satisfied ? "ok" : "bad"}">${t.satisfied ? "satisfied" : "failed"}</span></td><td class="num">${t.requirements}</td><td class="num">${t.recommendations}</td></tr>`).join("");

  const translationRows = Object.entries(report.translations.collections).map(([collection, byLocale]) =>
    `<tr><td><code>${escape(collection)}</code></td>${locales.map((l) => {
      const c = byLocale[l];
      return `<td class="num">${c ? `${percent(c)} <small>${c.translated}/${c.expected}${c.stale ? ` · ${c.stale} stale` : ""}${c.machine ? ` · ${c.machine} machine` : ""}</small>` : "–"}</td>`;
    }).join("")}</tr>`).join("");

  const issueRows = report.issues.map((i) =>
    `<tr class="${i.severity}"><td><span class="badge ${i.severity === "requirement" ? "bad" : "warn"}">${i.severity}</span></td><td>${escape(i.target ?? "")}</td><td><code>${escape([i.collection, i.id].filter(Boolean).join(" / "))}</code></td><td>${escape(i.locale ?? "")}</td><td><code>${escape(i.field ?? "")}</code></td><td class="nowrap">${escape(i.issue)}</td><td>${escape(i.message)}</td><td>${i.source ? `<a href="${escape(i.source)}">open</a>` : ""}</td></tr>`).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Publish report · ${escape(report.releaseId)}</title>
<style>
  :root { --bg: #f8fafc; --panel: #ffffff; --text: #0f172a; --muted: #64748b; --line: #e2e8f0; --ok: #047857; --bad: #b91c1c; --warn: #b45309; }
  @media (prefers-color-scheme: dark) { :root { --bg: #020617; --panel: #0f172a; --text: #e2e8f0; --muted: #94a3b8; --line: #1e293b; --ok: #34d399; --bad: #f87171; --warn: #fbbf24; } }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 16px; background: var(--bg); color: var(--text); font: 14px/1.5 system-ui, sans-serif; }
  main { max-width: 1200px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 16px; margin: 32px 0 12px; }
  .meta { color: var(--muted); }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-top: 20px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; }
  .card .value { font-size: 22px; font-weight: 700; } .card .label { color: var(--muted); font-size: 12px; }
  .card.bad .value { color: var(--bad); } .card.warn .value { color: var(--warn); } .card.ok .value { color: var(--ok); }
  .table { overflow-x: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-size: 12px; font-weight: 600; } tr:last-child td { border-bottom: 0; }
  .num { text-align: right; white-space: nowrap; } .nowrap { white-space: nowrap; } small { color: var(--muted); }
  code { font: 12px ui-monospace, monospace; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; border: 1px solid currentColor; }
  .badge.ok { color: var(--ok); } .badge.bad { color: var(--bad); } .badge.warn { color: var(--warn); }
  .error { margin-top: 16px; padding: 12px 16px; border: 1px solid var(--bad); border-radius: 12px; color: var(--bad); white-space: pre-wrap; }
  .empty { color: var(--muted); padding: 12px 16px; }
  ul { margin: 0; padding: 12px 16px 12px 32px; }
  a { color: inherit; }
</style>
</head>
<body>
<main>
  <h1>Publish report <span class="badge ${report.status === "published" ? "ok" : "bad"}">${report.status}</span></h1>
  <div class="meta">Release <code>${escape(report.releaseId)}</code> · channel <code>${escape(report.channel)}</code> · ${escape(report.createdAt)} · source locale <code>${escape(report.translations.sourceLocale)}</code> (${escape(report.translations.sourceLocaleOrigin)})</div>
  ${report.error ? `<div class="error">${escape(report.error)}</div>` : ""}

  <div class="cards">
    ${card("failed requirements", String(s.requirements), s.requirements ? "bad" : "ok")}
    ${card("recommendations", String(s.recommendations), s.recommendations ? "warn" : "ok")}
    ${card("warnings", String(s.warnings), s.warnings ? "warn" : "ok")}
    ${card("targets satisfied", `${s.targets.satisfied}/${s.targets.total}`, s.targets.satisfied === s.targets.total ? "ok" : "bad")}
    ${card("translated", `${percent(s.translations)}`, s.translations.missing || s.translations.stale ? "warn" : "ok")}
    ${report.release ? card("collections · items · media", `${report.release.collections} · ${report.release.items} · ${report.release.media}`) : ""}
  </div>

  <h2>Targets</h2>
  <div class="table"><table><thead><tr><th>Target</th><th>Status</th><th class="num">Failed requirements</th><th class="num">Recommendations</th></tr></thead><tbody>${targetRows}</tbody></table></div>

  <h2>Translations (vs. ${escape(report.translations.sourceLocale)})</h2>
  ${locales.length
    ? `<div class="table"><table><thead><tr><th>Collection</th>${locales.map((l) => `<th class="num">${escape(l)}</th>`).join("")}</tr></thead><tbody>${translationRows}</tbody></table></div>`
    : `<div class="table empty">No target locales.</div>`}

  <h2>Issues (${report.issues.length})</h2>
  ${report.issues.length
    ? `<div class="table"><table><thead><tr><th>Severity</th><th>Target</th><th>Item</th><th>Locale</th><th>Field</th><th>Issue</th><th>Message</th><th>Source</th></tr></thead><tbody>${issueRows}</tbody></table></div>`
    : `<div class="table empty">No issues.</div>`}

  <h2>Warnings (${report.warnings.length})</h2>
  ${report.warnings.length
    ? `<div class="table"><ul>${report.warnings.map((w) => `<li>${escape(w)}</li>`).join("")}</ul></div>`
    : `<div class="table empty">No warnings.</div>`}
</main>
</body>
</html>
`;
}
