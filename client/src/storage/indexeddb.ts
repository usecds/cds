import { ClientStorage, ReleaseManifest, ChannelManifest } from "../types.js";

export interface IndexedDBStorageOptions {
  /** The database's name; one per store a device syncs (default "cds") */
  name?: string;
  /** The IndexedDB implementation (default: the global `indexedDB`; tests pass fake-indexeddb's) */
  indexedDB?: IDBFactory;
}

type StoreName = "objects" | "media" | "releases" | "channels" | "meta";
const STORES: StoreName[] = ["objects", "media", "releases", "channels", "meta"];
const ACTIVE = "activeReleaseId";

/**
 * Keeps synced releases in the browser's IndexedDB, so a page or kiosk loads its active release
 * at startup without the network. Every write is its own transaction; the client writes the
 * active release ID last, so an interrupted sync (a closed tab, a full quota) leaves the
 * previous release active.
 */
export class IndexedDBStorage implements ClientStorage {
  private readonly name: string;
  private readonly factory: IDBFactory;
  private db: Promise<IDBDatabase> | null = null;

  constructor(options: IndexedDBStorageOptions = {}) {
    this.name = options.name ?? "cds";
    const factory = options.indexedDB ?? globalThis.indexedDB;
    if (!factory) throw new Error("IndexedDBStorage: no IndexedDB in this runtime");
    this.factory = factory;
  }

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const request = this.factory.open(this.name, 1);
      request.onupgradeneeded = () => {
        for (const store of STORES) if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store);
      };
      request.onsuccess = () => {
        const db = request.result;
        // Another tab upgrading the schema: let it, this connection reopens on its next use
        db.onversionchange = () => {
          db.close();
          this.db = null;
        };
        resolve(db);
      };
      request.onerror = () => {
        this.db = null;
        reject(request.error);
      };
    });
    return this.db;
  }

  // One request in its own transaction; resolves when the transaction has committed
  private async run<T>(store: StoreName, mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const request = op(tx.objectStore(store));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error ?? request.error);
      tx.onabort = () => reject(tx.error ?? new Error(`IndexedDB transaction on ${store} aborted`));
    });
  }

  private async get<T>(store: StoreName, key: string): Promise<T | null> {
    return ((await this.run(store, "readonly", (s) => s.get(key))) as T | undefined) ?? null;
  }

  private async has(store: StoreName, key: string): Promise<boolean> {
    return (await this.run(store, "readonly", (s) => s.count(key))) > 0;
  }

  private async put(store: StoreName, key: string, value: unknown): Promise<void> {
    await this.run(store, "readwrite", (s) => s.put(value, key));
  }

  async saveObject(hash: string, content: string): Promise<void> {
    await this.put("objects", hash, content);
  }

  async readObject(hash: string): Promise<string | null> {
    return this.get<string>("objects", hash);
  }

  async hasObject(hash: string): Promise<boolean> {
    return this.has("objects", hash);
  }

  async saveMedia(hash: string, content: Uint8Array): Promise<void> {
    await this.put("media", hash, content);
  }

  async readMedia(hash: string): Promise<Uint8Array | null> {
    return this.get<Uint8Array>("media", hash);
  }

  async hasMedia(hash: string): Promise<boolean> {
    return this.has("media", hash);
  }

  async saveRelease(releaseId: string, manifest: ReleaseManifest): Promise<void> {
    await this.put("releases", releaseId, manifest);
  }

  async readRelease(releaseId: string): Promise<ReleaseManifest | null> {
    return this.get<ReleaseManifest>("releases", releaseId);
  }

  async listReleases(): Promise<string[]> {
    return ((await this.run("releases", "readonly", (s) => s.getAllKeys())) as string[]).sort();
  }

  async deleteRelease(releaseId: string): Promise<void> {
    await this.run("releases", "readwrite", (s) => s.delete(releaseId));
  }

  async getActiveReleaseId(): Promise<string | null> {
    return this.get<string>("meta", ACTIVE);
  }

  async setActiveReleaseId(releaseId: string | null): Promise<void> {
    if (releaseId === null) await this.run("meta", "readwrite", (s) => s.delete(ACTIVE));
    else await this.put("meta", ACTIVE, releaseId);
  }

  async saveChannelManifest(channel: string, manifest: ChannelManifest): Promise<void> {
    await this.put("channels", channel, manifest);
  }

  async readChannelManifest(channel: string): Promise<ChannelManifest | null> {
    return this.get<ChannelManifest>("channels", channel);
  }

  /** Closes the connection (the next call opens it again) */
  close(): void {
    void this.db?.then((db) => db.close());
    this.db = null;
  }
}
