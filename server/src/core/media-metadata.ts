import { CollectionItem, MediaMeta } from "../types.js";
import { validateMediaMetadataItem } from "../validation.js";

// Reserved collection holding metadata (alt text, description, focal point, size) per media file
export const MEDIA_COLLECTION = "_media";

/**
 * Checks the _media collection: every item must match the schema and refer to a media
 * file in the release, and no media file may be described twice. Throws on the first problem.
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
