import { CollectionItem, TranslationCounts, TranslationSummary } from "../types.js";
import { sha256 } from "../utils.js";

export const DEFAULT_SOURCE_LOCALE = "en";

// How the source locale of a publish run was determined
export type SourceLocaleOrigin =
  | "argument" // passed to publish()
  | "source" // reported by the ContentSource
  | "inferred" // derived from _translation markers
  | "fallback"; // DEFAULT_SOURCE_LOCALE

export interface TranslationIssue {
  collection: string;
  id: string;
  locale: string;
  field: string;
  issue: "missing" | "stale";
}

// Full report for the build artifacts; the release manifest gets the TranslationSummary part
export interface TranslationReport extends TranslationSummary {
  sourceLocaleOrigin: SourceLocaleOrigin;
  collections: Record<string, Record<string, TranslationCounts>>; // collection -> locale -> counts
  itemsWithoutSource: { collection: string; id: string }[];
  issues: TranslationIssue[];
}

/**
 * Hash of a source text, as stored in _translation markers (sourceHash).
 */
export function translationSourceHash(text: string): string {
  return sha256(text);
}

/**
 * Infers the source locale from _translation markers: the locales of fields marked
 * "original" plus all "from" locales. Returns undefined unless exactly one candidate exists.
 */
export function inferSourceLocale(collections: Record<string, CollectionItem[]>): string | undefined {
  const candidates = new Set<string>();
  for (const items of Object.values(collections)) {
    for (const item of items) {
      for (const [locale, fields] of Object.entries(item._translation ?? {})) {
        for (const marker of Object.values(fields)) {
          if (marker.status === "original") candidates.add(locale);
          if (marker.from) candidates.add(marker.from);
        }
      }
    }
  }
  return candidates.size === 1 ? [...candidates][0] : undefined;
}

const emptyCounts = (): TranslationCounts => ({ expected: 0, translated: 0, missing: 0, stale: 0, machine: 0 });

function addCounts(target: TranslationCounts, add: TranslationCounts): void {
  target.expected += add.expected;
  target.translated += add.translated;
  target.missing += add.missing;
  target.stale += add.stale;
  target.machine += add.machine;
}

const isEmpty = (value: unknown) => value === undefined || value === null || value === "";

/**
 * Measures translation completeness against the source locale.
 *
 * - Expected: every source-locale field whose value is a non-empty string. Other source values are ignored.
 * - Missing: the translation is absent, null or "".
 * - Stale: the marker's sourceHash differs from the current source text. Without a sourceHash,
 *   falls back to the previous release: source text changed but the translation didn't.
 */
export function analyzeTranslations(
  collections: Record<string, CollectionItem[]>,
  sourceLocale: string,
  sourceLocaleOrigin: SourceLocaleOrigin,
  previous?: Record<string, CollectionItem[]>
): TranslationReport {
  const locales = new Set<string>();
  for (const items of Object.values(collections)) {
    for (const item of items) {
      Object.keys(item.translations).forEach((l) => locales.add(l));
    }
  }
  locales.delete(sourceLocale);
  const targetLocales = [...locales].sort();

  const report: TranslationReport = {
    sourceLocale,
    sourceLocaleOrigin,
    locales: Object.fromEntries(targetLocales.map((l) => [l, emptyCounts()])),
    overall: emptyCounts(),
    collections: {},
    itemsWithoutSource: [],
    issues: []
  };

  for (const [collection, items] of Object.entries(collections)) {
    const perLocale: Record<string, TranslationCounts> = Object.fromEntries(
      targetLocales.map((l) => [l, emptyCounts()])
    );
    report.collections[collection] = perLocale;
    const previousById = new Map((previous?.[collection] ?? []).map((i) => [i.id, i]));

    for (const item of items) {
      const sourceFields = item.translations[sourceLocale];
      if (!sourceFields) {
        report.itemsWithoutSource.push({ collection, id: item.id });
        continue;
      }
      const prevItem = previousById.get(item.id);

      for (const [field, sourceValue] of Object.entries(sourceFields)) {
        if (typeof sourceValue !== "string" || sourceValue.length === 0) continue;

        for (const locale of targetLocales) {
          const counts = perLocale[locale];
          counts.expected++;
          const value = item.translations[locale]?.[field];
          if (isEmpty(value)) {
            counts.missing++;
            report.issues.push({ collection, id: item.id, locale, field, issue: "missing" });
            continue;
          }

          counts.translated++;
          const marker = item._translation?.[locale]?.[field];
          if (marker?.status === "machine") counts.machine++;

          let stale = false;
          if (marker?.sourceHash) {
            const reference = item.translations[marker.from ?? sourceLocale]?.[field];
            stale = typeof reference === "string" && translationSourceHash(reference) !== marker.sourceHash;
          } else if (prevItem) {
            const prevSource = prevItem.translations[sourceLocale]?.[field];
            const prevValue = prevItem.translations[locale]?.[field];
            stale = typeof prevSource === "string" && prevSource !== sourceValue && prevValue === value;
          }
          if (stale) {
            counts.stale++;
            report.issues.push({ collection, id: item.id, locale, field, issue: "stale" });
          }
        }
      }
    }

    for (const locale of targetLocales) {
      addCounts(report.locales[locale], perLocale[locale]);
      addCounts(report.overall, perLocale[locale]);
    }
  }

  return report;
}

export function toTranslationSummary(report: TranslationReport): TranslationSummary {
  return { sourceLocale: report.sourceLocale, locales: report.locales, overall: report.overall };
}
