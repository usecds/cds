import { CollectionItem } from "../types.js";
import { validateLanguageItem, validateSiteItem } from "../validation.js";
import { ROUTES_COLLECTION } from "./site.js";

// Optional, typed reserved collections: the site's settings and the languages it's published in
export const SITE_COLLECTION = "_site";
export const LANGUAGES_COLLECTION = "_languages";

export interface SiteItem extends CollectionItem {
  defaultLanguage?: string;
}

/**
 * Checks _site and _languages (each only if present). Throws on the first problem: schema errors,
 * a _site with other than one item, the same language twice, a defaultLanguage that isn't a
 * language, and route paths in a language _languages doesn't list.
 */
export function validateSettings(collections: Record<string, CollectionItem[]>): void {
  const languages = collections[LANGUAGES_COLLECTION];
  const keys = new Set<string>();
  for (const language of languages ?? []) {
    validateLanguageItem(language);
    if (keys.has(language.key)) throw new Error(`Invalid _languages item (${language.id}): language "${language.key}" is listed twice`);
    keys.add(language.key);
  }

  const site = collections[SITE_COLLECTION];
  if (site) {
    if (site.length !== 1) throw new Error(`Invalid _site: needs exactly one item, has ${site.length}`);
    const item = site[0] as SiteItem;
    validateSiteItem(item);
    if (languages && item.defaultLanguage && !keys.has(item.defaultLanguage)) {
      throw new Error(`Invalid _site item (${item.id}): defaultLanguage "${item.defaultLanguage}" isn't in _languages`);
    }
  }

  if (languages) {
    for (const route of collections[ROUTES_COLLECTION] ?? []) {
      for (const [locale, t] of Object.entries(route.translations)) {
        if (typeof t?.path === "string" && !keys.has(locale)) {
          throw new Error(`Invalid _routes item (${route.id}): has a path in "${locale}", which isn't in _languages`);
        }
      }
    }
  }
}
