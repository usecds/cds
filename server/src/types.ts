export interface ChannelManifest {
  schemaVersion: 1;
  channel: string;
  releaseId: string;
  updatedAt: string; // ISO date-time string
}

export interface Reference {
  collection: string;
  id: string;
}

export type ProvenanceStatus = "original" | "human" | "machine" | "reviewed";

export interface ProvenanceMarker {
  status: ProvenanceStatus;
  from?: string; // translations: locale the text was translated from
  sourceHash?: string; // translations: sha256 of the source text at translation time
  model?: string; // machine: model/version that produced the value
}

// Where values came from: translated fields per locale, and non-localized fields
export interface Provenance {
  translations?: Record<string, Record<string, ProvenanceMarker>>; // locale -> field -> marker
  fields?: Record<string, ProvenanceMarker>; // field -> marker
}

export interface CollectionItem {
  id: string;
  key: string;
  translations: Record<string, Record<string, any>>;
  references?: Reference[];
  media?: string[];
  _provenance?: Provenance;
  [key: string]: any;
}

// Item of the reserved _media collection; id = the media file's virtual path
export interface MediaMetadataItem extends CollectionItem {
  translations: Record<string, { alt?: string | null; description?: string | null; [field: string]: any }>;
  focalPoint?: { x: number; y: number }; // 0..1, relative to width/height
  width?: number; // intrinsic size in pixels
  height?: number;
}

export interface Collection {
  schemaVersion: 1;
  collection: string;
  items: CollectionItem[];
}

export interface CollectionMeta {
  hash: string;
  itemCount: number;
  size: number; // bytes of the stored object
}

export interface MediaMeta {
  hash: string;
  size: number;
  mimeType: string;
}

export interface TranslationCounts {
  expected: number; // fields with a non-empty source text
  translated: number; // includes stale and machine
  missing: number;
  stale: number; // source text changed after translation
  machine: number;
}

export interface TranslationSummary {
  sourceLocale: string;
  locales: Record<string, TranslationCounts>; // excludes the source locale
  overall: TranslationCounts;
}

export interface ReleaseManifest {
  schemaVersion: 1;
  releaseId: string;
  createdAt: string; // ISO date-time string
  collections: Record<string, CollectionMeta>;
  media: Record<string, MediaMeta>;
  translations?: TranslationSummary;
  targets?: string[]; // targets whose requirements this release satisfies
}

// Media asset structure for CMS Source adapter
export interface SourceMedia {
  virtualPath: string; // e.g. "banners/hero.png"
  content: Buffer;
  mimeType: string;
}

// Where an item or media file lives in the source system (paths are relative to the source's baseUrl)
export interface SourceItemRef {
  id: string;
  path?: string;
}

export interface SourceMediaRef extends SourceItemRef {
  adapter: string;
}

// Source map: build artifact linking published content back to the source system. Never published.
export interface SourceMap {
  sources: Record<string, { baseUrl?: string }>; // keyed by adapter name
  collections: Record<string, {
    source?: { adapter: string; collection: string };
    items: Record<string, SourceItemRef>; // keyed by CDS item id
  }>;
  media: Record<string, SourceMediaRef>; // keyed by virtual path
}

// CMS source adapter interface
export interface ContentSource {
  getCollections(): Promise<Record<string, CollectionItem[]>>;
  getMedia(): Promise<SourceMedia[]>;
  getSourceMap?(): Promise<SourceMap>;
  getSourceLocale?(): Promise<string | undefined>; // the CMS's original-content language, if known
}

// Target storage adapter interface
export interface ObjectStore {
  writeObject(hash: string, content: string): Promise<void>;
  writeMedia(hash: string, ext: string, content: Buffer): Promise<void>;
  writeRelease(releaseId: string, manifest: ReleaseManifest): Promise<void>;
  writeChannelManifest(channel: string, manifest: ChannelManifest): Promise<void>;

  listChannels(): Promise<string[]>;
  readChannelManifest(channel: string): Promise<ChannelManifest | null>;
  
  readRelease(releaseId: string): Promise<ReleaseManifest | null>;
  listReleases(): Promise<string[]>;
  deleteRelease(releaseId: string): Promise<void>;
  
  readObject(hash: string): Promise<string | null>;
  listObjects(): Promise<string[]>;
  deleteObject(hash: string): Promise<void>;
  objectSize(hash: string): Promise<number | null>; // bytes, null if missing
  
  listMedia(): Promise<string[]>; // Returns filenames like "<hash>.<ext>"
  deleteMedia(filename: string): Promise<void>;
  mediaSize(filename: string): Promise<number | null>; // bytes, null if missing
}
