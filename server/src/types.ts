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

export interface CollectionItem {
  id: string;
  key: string;
  translations: Record<string, Record<string, any>>;
  references?: Reference[];
  media?: string[];
  [key: string]: any;
}

export interface Collection {
  schemaVersion: 1;
  collection: string;
  items: CollectionItem[];
}

export interface CollectionMeta {
  hash: string;
  itemCount: number;
  size?: number; // bytes of the stored object; absent in older releases
}

export interface MediaMeta {
  hash: string;
  size: number;
  mimeType: string;
}

export interface ReleaseManifest {
  schemaVersion: 1;
  releaseId: string;
  createdAt: string; // ISO date-time string
  collections: Record<string, CollectionMeta>;
  media: Record<string, MediaMeta>;
}

// Media asset structure for CMS Source adapter
export interface SourceMedia {
  virtualPath: string; // e.g. "banners/hero.png"
  content: Buffer;
  mimeType: string;
}

// CMS source adapter interface
export interface ContentSource {
  getCollections(): Promise<Record<string, CollectionItem[]>>;
  getMedia(): Promise<SourceMedia[]>;
}

// Target storage adapter interface
export interface ObjectStore {
  writeObject(hash: string, content: string): Promise<void>;
  writeMedia(hash: string, ext: string, content: Buffer): Promise<void>;
  writeRelease(releaseId: string, manifest: ReleaseManifest): Promise<void>;
  writeChannelManifest(channel: string, manifest: ChannelManifest): Promise<void>;
  
  readRelease(releaseId: string): Promise<ReleaseManifest | null>;
  listReleases(): Promise<string[]>;
  deleteRelease(releaseId: string): Promise<void>;
  
  listObjects(): Promise<string[]>;
  deleteObject(hash: string): Promise<void>;
  
  listMedia(): Promise<string[]>; // Returns filenames like "<hash>.<ext>"
  deleteMedia(filename: string): Promise<void>;
}
