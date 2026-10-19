// Browser and edge entry (the package's browser, worker and deno conditions): no Node APIs
export * from "./types.js";
export { CDSClient } from "./core/client.js";
export type { CDSClientConfig, CollectionHandle, LocaleView, LocalizedHandle, SyncResult } from "./core/client.js";
export { localize, resolveLocales } from "./core/locale.js";
export type { LocaleOptions, LocalizedItem } from "./core/locale.js";
export { MemoryStorage } from "./storage/memory.js";
export { IndexedDBStorage } from "./storage/indexeddb.js";
export type { IndexedDBStorageOptions } from "./storage/indexeddb.js";
export { HttpDownloader } from "./downloaders/http.js";
export { sha256, sha256Sync } from "./utils.js";
export { EditOverlay, formatAddress, parseAddress, readPath } from "./core/overlay.js";
export type { OverlayEdit, FieldAddress } from "./core/overlay.js";
