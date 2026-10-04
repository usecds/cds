import fs from "fs/promises";
import path from "path";
import { deterministicStringify } from "../utils.js";
import { validateTargetDefinition } from "../validation.js";

export const DEFAULT_TARGET_ID = "default";
export const RECOMMENDED_MAX_TARGETS = 8;

// Requirements (or recommendations) for one collection. Schemas are JSON Schema.
export interface CollectionRules {
  localized?: object; // checked against translations[locale] of every item
  fields?: object; // checked against the item itself
}

export interface CollectionRequirements extends CollectionRules {
  minItems?: number;
  presets?: string[]; // image presets for media referenced by this collection (image project contract)
}

// Image preset: the contract for the image processor (rendered outside CDS)
export interface MediaPreset {
  aspect?: string; // "3:1"
  fit?: "fill" | "fit";
  widths: Record<string, number>; // breakpoint name -> width in CSS px
  formats?: ("avif" | "webp" | "jpeg" | "png")[]; // the last one is the universal fallback
  quality?: number;
  lossless?: boolean;
  background?: string; // jpeg: color behind transparent areas
}

export interface TargetDefinition {
  id: string;
  scope?: string[]; // collections this target applies to; omitted = all
  locales?: {
    required?: string[];
    minCompleteness?: number; // 0..1, per required locale
    maxStale?: number;
  };
  collections?: Record<string, CollectionRequirements>; // listed = required
  items?: { collection: string; key: string }[]; // required named items
  recommendations?: Record<string, CollectionRules>; // reported, never failing
  media?: {
    breakpoints?: Record<string, number>; // name -> minimum screen width (CSS px)
    dpr?: number[]; // device pixel ratios to render, e.g. [1, 2]
    presets?: Record<string, MediaPreset>;
  };
}

/**
 * Used when no default target is provided.
 */
export const BUILTIN_DEFAULT_TARGET: TargetDefinition = {
  id: DEFAULT_TARGET_ID,
  recommendations: {
    _media: {
      localized: {
        type: "object",
        required: ["alt", "description"],
        properties: {
          alt: { type: "string", minLength: 1, maxLength: 125 },
          description: { type: "string", minLength: 50, maxLength: 300 }
        }
      }
    },
    _pages: {
      localized: {
        type: "object",
        required: ["title", "description"],
        properties: {
          title: { type: "string", minLength: 1, maxLength: 60 },
          description: { type: "string", minLength: 50, maxLength: 160 }
        }
      }
    }
  }
};

export interface ResolvedTargets {
  defaultTarget: TargetDefinition;
  named: TargetDefinition[];
  effective: Record<string, TargetDefinition>; // named targets merged with the default (and the default itself)
  warnings: string[];
}

/**
 * Loads all *.json target definitions from a folder. default.json is the default target.
 */
export async function loadTargets(dir: string): Promise<TargetDefinition[]> {
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  const targets: TargetDefinition[] = [];
  for (const file of files) {
    const target = JSON.parse(await fs.readFile(path.join(dir, file), "utf-8"));
    validateTargetDefinition(target);
    const expectedDefault = file === `${DEFAULT_TARGET_ID}.json`;
    if (expectedDefault !== (target.id === DEFAULT_TARGET_ID)) {
      throw new Error(`Target file ${file}: only default.json may (and must) use the id "${DEFAULT_TARGET_ID}"`);
    }
    targets.push(target);
  }
  return targets;
}

/**
 * Validates the given definitions, picks the default target (built-in if none) and
 * computes each named target's effective definition (default merged with its own).
 */
export function resolveTargets(definitions: TargetDefinition[]): ResolvedTargets {
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const def of definitions) {
    validateTargetDefinition(def);
    if (seen.has(def.id)) throw new Error(`Duplicate target id: ${def.id}`);
    seen.add(def.id);
    if (def.id !== DEFAULT_TARGET_ID) checkOwnScope(def);
  }

  const defaultTarget = definitions.find((d) => d.id === DEFAULT_TARGET_ID) ?? BUILTIN_DEFAULT_TARGET;
  if (defaultTarget.scope) {
    throw new Error(`The default target applies to everything and can't declare a scope`);
  }
  const named = definitions.filter((d) => d.id !== DEFAULT_TARGET_ID);
  if (named.length > RECOMMENDED_MAX_TARGETS) {
    warnings.push(`${named.length} named targets; the recommended maximum is ${RECOMMENDED_MAX_TARGETS}`);
  }

  checkPresetConflicts([defaultTarget, ...named]);
  checkBreakpoints([defaultTarget, ...named]);

  const effective: Record<string, TargetDefinition> = { [DEFAULT_TARGET_ID]: defaultTarget };
  for (const target of named) {
    effective[target.id] = mergeTargets(defaultTarget, target);
  }
  return { defaultTarget, named, effective, warnings };
}

/**
 * Additive merge: lists are combined, thresholds take the stricter value, schemas are
 * combined with allOf (both must pass). Nothing is overwritten. Scope is the named target's own.
 */
export function mergeTargets(base: TargetDefinition, own: TargetDefinition): TargetDefinition {
  const merged: TargetDefinition = { id: own.id };
  if (own.scope) merged.scope = [...own.scope];

  const locales = {
    required: union(base.locales?.required, own.locales?.required),
    minCompleteness: stricter(base.locales?.minCompleteness, own.locales?.minCompleteness, Math.max),
    maxStale: stricter(base.locales?.maxStale, own.locales?.maxStale, Math.min)
  };
  if (locales.required || locales.minCompleteness !== undefined || locales.maxStale !== undefined) {
    merged.locales = dropUndefined(locales);
  }

  const collections = mergeRecords(base.collections, own.collections, (a, b) =>
    dropUndefined({
      minItems: stricter(a.minItems, b.minItems, Math.max),
      localized: allOf(a.localized, b.localized),
      fields: allOf(a.fields, b.fields),
      presets: union(a.presets, b.presets)
    })
  );
  if (collections) merged.collections = collections;

  const items = unionBy([...(base.items ?? []), ...(own.items ?? [])], (i) => `${i.collection}\u0000${i.key}`);
  if (items.length) merged.items = items;

  const recommendations = mergeRecords(base.recommendations, own.recommendations, (a, b) =>
    dropUndefined({ localized: allOf(a.localized, b.localized), fields: allOf(a.fields, b.fields) })
  );
  if (recommendations) merged.recommendations = recommendations;

  if (base.media || own.media) {
    merged.media = dropUndefined({
      breakpoints: base.media?.breakpoints || own.media?.breakpoints
        ? { ...base.media?.breakpoints, ...own.media?.breakpoints }
        : undefined,
      dpr: union(base.media?.dpr, own.media?.dpr)?.sort((x, y) => x - y),
      presets: base.media?.presets || own.media?.presets ? { ...base.media?.presets, ...own.media?.presets } : undefined
    });
  }
  return merged;
}

// A named target's own requirements and recommendations must stay within its own scope
function checkOwnScope(target: TargetDefinition): void {
  if (!target.scope) return;
  const scope = new Set(target.scope);
  const outside = [
    ...Object.keys(target.collections ?? {}),
    ...Object.keys(target.recommendations ?? {}),
    ...(target.items ?? []).map((i) => i.collection)
  ].filter((c) => !scope.has(c));
  if (outside.length) {
    throw new Error(`Target ${target.id} declares rules outside its scope: ${[...new Set(outside)].join(", ")}`);
  }
}

// All variants land in one release, so a preset name must mean the same thing in every target
function checkPresetConflicts(targets: TargetDefinition[]): void {
  const presets = new Map<string, { target: string; definition: string }>();
  for (const target of targets) {
    for (const [name, preset] of Object.entries(target.media?.presets ?? {})) {
      const definition = deterministicStringify(preset);
      const existing = presets.get(name);
      if (existing && existing.definition !== definition) {
        throw new Error(`Preset "${name}" is defined differently in targets ${existing.target} and ${target.id}`);
      }
      presets.set(name, { target: target.id, definition });
    }
  }
}

// Breakpoints are shared like presets: one name, one width. Presets may only use declared breakpoints.
function checkBreakpoints(targets: TargetDefinition[]): void {
  const widths = new Map<string, { target: string; minWidth: number }>();
  for (const target of targets) {
    for (const [name, minWidth] of Object.entries(target.media?.breakpoints ?? {})) {
      const existing = widths.get(name);
      if (existing && existing.minWidth !== minWidth) {
        throw new Error(`Breakpoint "${name}" is defined differently in targets ${existing.target} and ${target.id}`);
      }
      widths.set(name, { target: target.id, minWidth });
    }
  }
  for (const target of targets) {
    for (const [presetName, preset] of Object.entries(target.media?.presets ?? {})) {
      for (const breakpoint of Object.keys(preset.widths)) {
        if (!widths.has(breakpoint)) {
          throw new Error(`Preset "${presetName}" in target ${target.id} uses unknown breakpoint "${breakpoint}"`);
        }
      }
    }
  }
}

function union<T>(a?: T[], b?: T[]): T[] | undefined {
  if (!a && !b) return undefined;
  return [...new Set([...(a ?? []), ...(b ?? [])])];
}

function unionBy<T>(list: T[], key: (item: T) => string): T[] {
  const map = new Map<string, T>();
  for (const item of list) map.set(key(item), item);
  return [...map.values()];
}

function stricter(a: number | undefined, b: number | undefined, pick: (x: number, y: number) => number) {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return pick(a, b);
}

function allOf(a?: object, b?: object): object | undefined {
  if (!a) return b;
  if (!b) return a;
  if (deterministicStringify(a) === deterministicStringify(b)) return a;
  return { allOf: [a, b] };
}

function mergeRecords<T>(
  a: Record<string, T> | undefined,
  b: Record<string, T> | undefined,
  merge: (x: T, y: T) => T
): Record<string, T> | undefined {
  if (!a && !b) return undefined;
  const result: Record<string, T> = { ...a };
  for (const [key, value] of Object.entries(b ?? {})) {
    result[key] = key in result ? merge(result[key], value) : value;
  }
  return result;
}

function dropUndefined<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}
