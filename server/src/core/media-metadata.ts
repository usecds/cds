import { CollectionItem, MediaMeta } from "../types.js";
import { validateMediaMetadataItem } from "../validation.js";

// Reserved collection holding metadata (alt text, description, focal point, size) per media file
export const MEDIA_COLLECTION = "_media";

/**
 * Checks the _media collection: every item must match the schema and refer to a media
 * file in the release, and no media file may be described twice. Throws on the first problem.
 * (The publisher has already dropped entries for media that isn't published.)
 */
export function validateMediaMetadata(items: CollectionItem[], media: Record<string, MediaMeta>): void {
  const seen = new Set<string>();
  for (const item of items) {
    validateMediaMetadataItem(item);
    if (!media[item.id]) {
      throw new Error(`Invalid _media item (${item.id}): no media file with this virtual path in the release`);
    }
    if (seen.has(item.id)) {
      throw new Error(`Invalid _media item (${item.id}): described more than once`);
    }
    seen.add(item.id);
  }
}

/**
 * Where media files are used: "all" when listed in an item's media array, otherwise the
 * locales whose translations list it (translations[locale].media, for language-specific media).
 * Media that isn't used anywhere is not published.
 */
export type MediaUsage = Map<string, "all" | Set<string>>;

export function collectMediaUsage(collections: Record<string, CollectionItem[]>): MediaUsage {
  const usage: MediaUsage = new Map();
  for (const [collection, items] of Object.entries(collections)) {
    if (collection === MEDIA_COLLECTION) continue;
    for (const item of items) {
      for (const path of item.media ?? []) usage.set(path, "all");
      for (const [locale, fields] of Object.entries(item.translations)) {
        const localized = fields?.media;
        if (!Array.isArray(localized)) continue;
        for (const path of localized) {
          const current = usage.get(path);
          if (current === "all") continue;
          usage.set(path, (current ?? new Set<string>()).add(locale));
        }
      }
    }
  }
  return usage;
}

/**
 * Locales in which a media file is shown, so its _media texts are expected only there.
 * Undefined means every locale.
 */
export function mediaLocales(usage: MediaUsage, path: string): string[] | undefined {
  const used = usage.get(path);
  return used === undefined || used === "all" ? undefined : [...used].sort();
}
