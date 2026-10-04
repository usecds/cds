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
  focalPoints?: Record<string, { x: number; y: number }>; // named points of interest, e.g. per crop
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

// Combined view of a media file: release entry plus its _media metadata
export interface MediaInfo {
  path: string; // virtual path
  hash: string;
  size: number; // bytes
  mimeType: string;
  width?: number;
  height?: number;
  focalPoint?: { x: number; y: number };
  focalPoints?: Record<string, { x: number; y: number }>;
  alt?: string; // in the requested locale
  description?: string;
}

// Client Storage Interface
export interface ClientStorage {
  saveObject(hash: string, content: string): Promise<void>;
  readObject(hash: string): Promise<string | null>;
  hasObject(hash: string): Promise<boolean>;
  
  saveMedia(hash: string, content: Buffer): Promise<void>;
  readMedia(hash: string): Promise<Buffer | null>;
  hasMedia(hash: string): Promise<boolean>;
  
  saveRelease(releaseId: string, manifest: ReleaseManifest): Promise<void>;
  readRelease(releaseId: string): Promise<ReleaseManifest | null>;
  listReleases(): Promise<string[]>;
  deleteRelease(releaseId: string): Promise<void>;
  
  getActiveReleaseId(): Promise<string | null>;
  setActiveReleaseId(releaseId: string | null): Promise<void>;
  
  saveChannelManifest(channel: string, manifest: ChannelManifest): Promise<void>;
  readChannelManifest(channel: string): Promise<ChannelManifest | null>;
}

// Remote Downloader Interface
export interface RemoteDownloader {
  fetchChannelManifest(channel: string, currentEtag?: string): Promise<{ manifest: ChannelManifest; etag?: string; notModified?: boolean }>;
  fetchReleaseManifest(releaseId: string): Promise<ReleaseManifest>;
  fetchObject(hash: string): Promise<string>;
  fetchMedia(hash: string, ext: string): Promise<Buffer>;
}
