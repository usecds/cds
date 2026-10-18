import { CollectionItem } from "../types.js";

export interface LocaleOptions {
  /**
   * Locales to try after the requested one and its language, before the release's source locale
   * (e.g. ["en"] for a German screen that should rather show English than nothing). False: the
   * requested locale only, no fallbacks.
   */
  fallback?: string[] | false;
}

/**
 * An item read in one language: its values, plus each text in the first locale of the fallbacks
 * that has it. `$locales` says which locale each text came from (a fallback shows as a different
 * locale, e.g. to mark untranslated texts). A text none of the locales has is null.
 */
export type LocalizedItem = Omit<CollectionItem, "translations"> & {
  [field: string]: unknown;
  $locales: Record<string, string>;
};

const normalize = (locale: string) => locale.replace(/_/g, "-").toLowerCase();
const language = (locale: string) => normalize(locale).split("-")[0]!;

/**
 * The locales to read, in order: the requested one, its language ("de" for "de-DE"), the
 * language's other regions ("de-AT"), the given fallbacks, then the source locale. Matching
 * ignores case and "_" vs "-"; the release's own spelling is used.
 */
export function resolveLocales(requested: string, available: string[], sourceLocale?: string, options: LocaleOptions = {}): string[] {
  const find = (locale: string) => available.find((l) => normalize(l) === normalize(locale));
  const chain: string[] = [];
  const add = (locale: string | undefined) => {
    if (locale && !chain.some((l) => normalize(l) === normalize(locale))) chain.push(locale);
  };
  add(find(requested) ?? requested);
  if (options.fallback === false) return chain;
  add(find(language(requested)));
  available.filter((l) => language(l) === language(requested)).sort().forEach(add);
  for (const fallback of options.fallback ?? []) add(find(fallback) ?? fallback);
  if (sourceLocale) add(find(sourceLocale) ?? sourceLocale);
  return chain;
}

// Empty texts count as missing: an untranslated field is often stored as ""
const present = (value: unknown) => value !== undefined && value !== null && value !== "";

/** The item with its texts resolved along the locales (see LocalizedItem) */
export function localize(item: CollectionItem, locales: string[]): LocalizedItem {
  const { translations, ...values } = item;
  const out: LocalizedItem = { ...values, $locales: {} };
  // Every text the item has in any locale, so the shape doesn't depend on the language
  const fields = new Set(Object.values(translations).flatMap((texts) => Object.keys(texts ?? {})));
  for (const field of fields) {
    const locale = locales.find((l) => present(translations[l]?.[field]));
    out[field] = locale ? translations[locale]![field] : null;
    if (locale) out.$locales[field] = locale;
  }
  return out;
}
