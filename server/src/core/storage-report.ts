import { ObjectStore, ReleaseManifest } from "../types.js";

// A stored file: objects/<hash>.json or media/<hash>.<ext>
export interface StoredFile {
  kind: "object" | "media";
  hash: string;
  file: string; // path relative to the storage root
  bytes: number | null; // null if referenced but missing from the store
}

export interface ReleaseDiff {
  previousReleaseId: string;
  added: string[]; // file paths new in this release
  removed: string[]; // file paths referenced by the previous release only
  shared: number; // files referenced by both
}

export interface ReleaseUsage {
  releaseId: string;
  channels: string[]; // channels currently pointing at this release
  objects: number;
  media: number;
  bytes: number; // total size of all referenced files
  uniqueBytes: number; // size of files referenced by no other retained release (freed if deleted)
  missing: string[]; // referenced files that don't exist in the store
  diff: ReleaseDiff | null; // null for the oldest retained release
}

export interface StorageReport {
  releases: ReleaseUsage[]; // oldest first (lexicographic release ID order)
  channels: Record<string, { releaseId: string; retained: boolean }>;
  totals: { objects: number; media: number; bytes: number };
  orphans: { files: StoredFile[]; bytes: number }; // exactly what garbage collection deletes
}

/**
 * Walks the store and reports per-release usage, release-to-release diffs,
 * channel pointers and orphaned files. Read-only.
 */
export async function analyzeStorage(store: ObjectStore): Promise<StorageReport> {
  // 1. Inventory of stored files
  const files = new Map<string, StoredFile>(); // keyed by file path
  const mediaFilesByHash = new Map<string, string[]>();

  for (const hash of await store.listObjects()) {
    const file = `objects/${hash}.json`;
    files.set(file, { kind: "object", hash, file, bytes: await store.objectSize(hash) });
  }
  for (const filename of await store.listMedia()) {
    // Filename is <hash>.<ext>
    const hash = filename.split(".")[0];
    const file = `media/${filename}`;
    files.set(file, { kind: "media", hash, file, bytes: await store.mediaSize(filename) });
    mediaFilesByHash.set(hash, [...(mediaFilesByHash.get(hash) ?? []), file]);
  }

  // 2. Channel pointers
  const channels: StorageReport["channels"] = {};
  const releaseIds = (await store.listReleases()).sort();
  for (const channel of await store.listChannels()) {
    const manifest = await store.readChannelManifest(channel);
    if (manifest) {
      channels[channel] = { releaseId: manifest.releaseId, retained: releaseIds.includes(manifest.releaseId) };
    }
  }

  // 3. Files referenced by each retained release
  const referencesByRelease = new Map<string, { files: Set<string>; manifest: ReleaseManifest }>();
  for (const releaseId of releaseIds) {
    const manifest = await store.readRelease(releaseId);
    if (!manifest) continue;
    const referenced = new Set<string>();
    for (const col of Object.values(manifest.collections)) {
      referenced.add(`objects/${col.hash}.json`);
    }
    for (const [virtualPath, med] of Object.entries(manifest.media)) {
      const stored = mediaFilesByHash.get(med.hash);
      if (stored) {
        stored.forEach((f) => referenced.add(f));
      } else {
        const ext = virtualPath.includes(".") ? virtualPath.substring(virtualPath.lastIndexOf(".")) : "";
        referenced.add(`media/${med.hash}${ext}`);
      }
    }
    referencesByRelease.set(releaseId, { files: referenced, manifest });
  }

  const referenceCount = new Map<string, number>();
  for (const { files: referenced } of referencesByRelease.values()) {
    referenced.forEach((f) => referenceCount.set(f, (referenceCount.get(f) ?? 0) + 1));
  }

  // 4. Per-release usage and diff against the previous retained release
  const releases: ReleaseUsage[] = [];
  let previous: { releaseId: string; files: Set<string> } | null = null;
  for (const [releaseId, { files: referenced }] of referencesByRelease) {
    const usage: ReleaseUsage = {
      releaseId,
      channels: Object.keys(channels).filter((c) => channels[c].releaseId === releaseId),
      objects: 0,
      media: 0,
      bytes: 0,
      uniqueBytes: 0,
      missing: [],
      diff: null
    };
    for (const file of referenced) {
      const stored = files.get(file);
      if (!stored || stored.bytes === null) {
        usage.missing.push(file);
        continue;
      }
      if (stored.kind === "object") usage.objects++;
      else usage.media++;
      usage.bytes += stored.bytes;
      if (referenceCount.get(file) === 1) usage.uniqueBytes += stored.bytes;
    }
    if (previous) {
      const prevFiles = previous.files;
      usage.diff = {
        previousReleaseId: previous.releaseId,
        added: [...referenced].filter((f) => !prevFiles.has(f)),
        removed: [...prevFiles].filter((f) => !referenced.has(f)),
        shared: [...referenced].filter((f) => prevFiles.has(f)).length
      };
    }
    releases.push(usage);
    previous = { releaseId, files: referenced };
  }

  // 5. Totals and orphans
  const all = [...files.values()];
  const orphanFiles = all.filter((f) => !referenceCount.has(f.file));
  return {
    releases,
    channels,
    totals: {
      objects: all.filter((f) => f.kind === "object").length,
      media: all.filter((f) => f.kind === "media").length,
      bytes: sum(all)
    },
    orphans: { files: orphanFiles, bytes: sum(orphanFiles) }
  };
}

function sum(files: StoredFile[]): number {
  return files.reduce((total, f) => total + (f.bytes ?? 0), 0);
}
