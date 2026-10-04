import { CollectionItem, SourceMap } from "../types.js";
import { compileContentSchema, ContentSchemaError } from "../validation.js";
import { deterministicStringify } from "../utils.js";
import { CollectionRules, DEFAULT_TARGET_ID, ResolvedTargets, TargetDefinition } from "./targets.js";
import { ItemLocales, TranslationReport } from "./translations.js";

export type IssueSeverity = "requirement" | "recommendation";

export interface ContentIssue {
  severity: IssueSeverity; // requirements fail the build, recommendations are only reported
  target?: string; // target that declared the rule; absent for translation issues
  issue: string; // e.g. missing, too-short, too-long, invalid, untranslated, stale, missing-collection
  message: string;
  collection?: string;
  id?: string;
  locale?: string;
  field?: string;
  length?: number; // actual length, for too-short / too-long
  recommended?: string; // e.g. "50–300 characters"
  source?: string; // deep link into the content source (from the source map)
}

export interface TargetResult {
  satisfied: boolean; // no failed requirements, including the default target's
  requirements: number; // failed requirements declared by this target
  recommendations: number;
}

export interface ContentReport {
  targets: Record<string, TargetResult>;
  issues: ContentIssue[];
  warnings: string[];
}

interface Context {
  collections: Record<string, CollectionItem[]>;
  translations: TranslationReport;
  sourceMap?: SourceMap;
  allLocales: string[];
  itemLocales?: ItemLocales;
}

/**
 * Checks every target's own declarations against the content. A named target is effectively
 * the default plus its own rules, so evaluating each declaration once gives the merged result
 * without duplicate issues.
 */
export function buildContentReport(
  collections: Record<string, CollectionItem[]>,
  translations: TranslationReport,
  resolved: ResolvedTargets,
  sourceMap?: SourceMap,
  itemLocales?: ItemLocales
): ContentReport {
  const allLocales = new Set<string>();
  for (const items of Object.values(collections)) {
    items.forEach((item) => Object.keys(item.translations).forEach((l) => allLocales.add(l)));
  }
  const ctx: Context = { collections, translations, sourceMap, allLocales: [...allLocales].sort(), itemLocales };

  const report: ContentReport = { targets: {}, issues: [], warnings: [...resolved.warnings] };

  for (const issue of translations.issues) {
    report.issues.push({
      severity: "recommendation",
      issue: issue.issue === "missing" ? "untranslated" : "stale",
      message: issue.issue === "missing"
        ? `${issue.field} is not translated to ${issue.locale}`
        : `${issue.field} (${issue.locale}) is stale: the ${translations.sourceLocale} source changed after translation`,
      collection: issue.collection,
      id: issue.id,
      locale: issue.locale,
      field: issue.field,
      source: sourceLink(ctx, issue.collection, issue.id)
    });
  }

  const defaultIssues = evaluateTarget(ctx, resolved.defaultTarget);
  report.issues.push(...defaultIssues);
  const defaultFailed = countBy(defaultIssues, "requirement");
  report.targets[DEFAULT_TARGET_ID] = {
    satisfied: defaultFailed === 0,
    requirements: defaultFailed,
    recommendations: countBy(defaultIssues, "recommendation")
  };

  for (const target of resolved.named) {
    const issues = evaluateTarget(ctx, target);
    report.issues.push(...issues);
    const failed = countBy(issues, "requirement");
    report.targets[target.id] = {
      satisfied: failed === 0 && defaultFailed === 0,
      requirements: failed,
      recommendations: countBy(issues, "recommendation")
    };
  }

  return report;
}

function evaluateTarget(ctx: Context, target: TargetDefinition): ContentIssue[] {
  const issues: ContentIssue[] = [];
  const inScope = (collection: string) => !target.scope || target.scope.includes(collection);
  const scoped = Object.keys(ctx.collections).filter(inScope);
  const sourceLocale = ctx.translations.sourceLocale;
  const requirement = (issue: Omit<ContentIssue, "severity" | "target">) =>
    issues.push({ severity: "requirement", target: target.id, ...issue });

  // Locales: presence, completeness and staleness within the target's scope
  const required = target.locales?.required;
  for (const locale of required ?? []) {
    const present = scoped.some((c) => ctx.collections[c].some((item) => item.translations[locale]));
    if (!present) requirement({ issue: "missing-locale", locale, message: `Required locale ${locale} has no content` });
  }
  const thresholdLocales = (required ?? Object.keys(ctx.translations.locales)).filter((l) => l !== sourceLocale);
  let stale = 0;
  for (const locale of thresholdLocales) {
    let expected = 0;
    let translated = 0;
    for (const c of scoped) {
      const counts = ctx.translations.collections[c]?.[locale];
      if (!counts) continue;
      expected += counts.expected;
      translated += counts.translated;
      stale += counts.stale;
    }
    const min = target.locales?.minCompleteness;
    const completeness = expected === 0 ? 1 : translated / expected;
    if (min !== undefined && completeness < min) {
      requirement({
        issue: "incomplete-locale",
        locale,
        message: `${locale} is ${percent(completeness)} translated, ${percent(min)} required`
      });
    }
  }
  const maxStale = target.locales?.maxStale;
  if (maxStale !== undefined && stale > maxStale) {
    requirement({ issue: "too-many-stale", message: `${stale} stale translations, at most ${maxStale} allowed` });
  }

  // Required collections and their schemas
  const ruleLocales = required ?? [sourceLocale];
  for (const [collection, rules] of Object.entries(target.collections ?? {})) {
    const items = ctx.collections[collection];
    if (!items) {
      requirement({ issue: "missing-collection", collection, message: `Required collection ${collection} is missing` });
      continue;
    }
    if (rules.minItems !== undefined && items.length < rules.minItems) {
      requirement({
        issue: "too-few-items",
        collection,
        message: `${collection} has ${items.length} items, at least ${rules.minItems} required`
      });
    }
    issues.push(...checkRules(ctx, target.id, "requirement", collection, items, rules, ruleLocales));
  }

  // Required named items
  for (const { collection, key } of target.items ?? []) {
    if (!ctx.collections[collection]?.some((item) => item.key === key)) {
      requirement({ issue: "missing-item", collection, message: `Required item ${collection}/${key} is missing` });
    }
  }

  // Recommendations apply to every locale in the content
  for (const [collection, rules] of Object.entries(target.recommendations ?? {})) {
    const items = ctx.collections[collection];
    if (!items || !inScope(collection)) continue;
    issues.push(...checkRules(ctx, target.id, "recommendation", collection, items, rules, ctx.allLocales));
  }

  return issues;
}

function checkRules(
  ctx: Context,
  target: string,
  severity: IssueSeverity,
  collection: string,
  items: CollectionItem[],
  rules: CollectionRules,
  locales: string[]
): ContentIssue[] {
  const issues: ContentIssue[] = [];
  const localized = rules.localized ? compiled(rules.localized) : undefined;
  const fields = rules.fields ? compiled(rules.fields) : undefined;

  for (const item of items) {
    const base = { severity, target, collection, id: item.id, source: sourceLink(ctx, collection, item.id) };
    const usedIn = ctx.itemLocales?.(collection, item);
    if (localized) {
      for (const locale of usedIn ? locales.filter((l) => usedIn.includes(l)) : locales) {
        const data = withoutEmpty(item.translations[locale] ?? {});
        for (const error of localized(data)) {
          issues.push({ ...base, locale, ...describe(error, data, rules.localized!) });
        }
      }
    }
    if (fields) {
      const data = withoutEmpty(item);
      for (const error of fields(data)) {
        issues.push({ ...base, ...describe(error, data, rules.fields!) });
      }
    }
  }
  return dedupe(issues);
}

// Converts a JSON Schema violation into issue fields
function describe(error: ContentSchemaError, data: any, schema: object) {
  const parent = error.instancePath ? error.instancePath.slice(1).split("/") : [];
  const fieldPath = error.keyword === "required" ? [...parent, error.params.missingProperty] : parent;
  const field = fieldPath.join(".") || undefined;
  const limits = field ? lengthLimits(schema, fieldPath[0]) : {};
  const recommended = formatLimits(limits);
  const value = fieldPath.reduce((v: any, k) => v?.[k], data);
  const length = typeof value === "string" ? [...value].length : undefined;
  const hint = recommended ? ` (recommended ${recommended})` : "";

  switch (error.keyword) {
    case "required":
      return { issue: "missing", field, recommended, message: `${field} is missing${hint}` };
    case "minLength":
      return { issue: "too-short", field, length, recommended, message: `${field} is too short: ${length} characters${hint}` };
    case "maxLength":
      return { issue: "too-long", field, length, recommended, message: `${field} is too long: ${length} characters${hint}` };
    default:
      return { issue: "invalid", field, message: `${field ?? "item"} ${error.message ?? "is invalid"}` };
  }
}

// minLength/maxLength declared for a top-level property, across allOf branches (stricter wins)
function lengthLimits(schema: any, property: string): { min?: number; max?: number } {
  const result: { min?: number; max?: number } = {};
  const visit = (s: any) => {
    if (!s || typeof s !== "object") return;
    const prop = s.properties?.[property];
    if (prop?.minLength !== undefined) result.min = Math.max(result.min ?? 0, prop.minLength);
    if (prop?.maxLength !== undefined) result.max = Math.min(result.max ?? Infinity, prop.maxLength);
    (s.allOf ?? []).forEach(visit);
  };
  visit(schema);
  return result;
}

function formatLimits({ min, max }: { min?: number; max?: number }): string | undefined {
  if (min !== undefined && max !== undefined) return `${min}–${max} characters`;
  if (max !== undefined) return `≤${max} characters`;
  if (min !== undefined) return `≥${min} characters`;
  return undefined;
}

function sourceLink(ctx: Context, collection: string, id: string): string | undefined {
  const map = ctx.sourceMap;
  if (!map) return undefined;
  let adapter: string | undefined;
  let ref: { path?: string } | undefined;
  if (collection === "_media" && map.media[id]) {
    ref = map.media[id];
    adapter = map.media[id].adapter;
  } else {
    ref = map.collections[collection]?.items[id];
    adapter = map.collections[collection]?.source?.adapter;
  }
  if (!ref?.path) return undefined;
  const baseUrl = adapter ? map.sources[adapter]?.baseUrl : undefined;
  return baseUrl ? baseUrl.replace(/\/$/, "") + ref.path : ref.path;
}

// Empty values count as missing, so "required" catches them (consistent with translation completeness)
function withoutEmpty(obj: Record<string, any>): Record<string, any> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ""));
}

const schemaCache = new Map<string, (data: any) => ContentSchemaError[]>();
function compiled(schema: object) {
  const key = deterministicStringify(schema);
  let fn = schemaCache.get(key);
  if (!fn) {
    fn = compileContentSchema(schema);
    schemaCache.set(key, fn);
  }
  return fn;
}

function dedupe(issues: ContentIssue[]): ContentIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const key = [i.target, i.collection, i.id, i.locale, i.field, i.issue].join("\u0000");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const countBy = (issues: ContentIssue[], severity: IssueSeverity) => issues.filter((i) => i.severity === severity).length;
const percent = (x: number) => `${Math.floor(x * 1000) / 10}%`;
