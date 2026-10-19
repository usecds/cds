import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { IDBFactory } from "fake-indexeddb";
import { Publisher, FilesystemStore, CollectionItem, ContentSource, SourceMedia } from "../server/src/index.js";
import {
  CDSClient,
  ClientStorage,
  MemoryStorage,
  FilesystemStorage,
  IndexedDBStorage,
  RemoteDownloader,
  ReleaseManifest,
  sha256,
  sha256Sync
} from "../client/src/index.js";
import { downloaderFor } from "./helpers.js";

// G12: the client in browsers and edge runtimes (Web Crypto hashing, Uint8Array media, IndexedDB)

const nodeSha256 = (content: string | Uint8Array) => crypto.createHash("sha256").update(content).digest("hex");

const FIXTURES: [string, string | Uint8Array][] = [
  ["empty", ""],
  ["ASCII", "Call us at the front desk"],
  ["umlauts", "Grüße aus Zürich, Straße"],
  ["emoji", "Hotel 🏨 with spa 💆 and 日本語"],
  ["binary", new Uint8Array(crypto.randomBytes(4096))],
  ["1 MB", new Uint8Array(crypto.randomBytes(1024 * 1024))]
];

describe("Hashing (G12)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(FIXTURES)("Web Crypto and the fallback match Node's crypto: %s", async (_name, content) => {
    const expected = nodeSha256(content);
    expect(await sha256(content)).toBe(expected);
    expect(sha256Sync(content)).toBe(expected);
  });

  it("falls back to plain JavaScript without crypto.subtle (no secure context)", async () => {
    vi.stubGlobal("crypto", {});
    expect(globalThis.crypto.subtle).toBeUndefined();
    for (const [, content] of FIXTURES) expect(await sha256(content)).toBe(nodeSha256(content));
  });
});

// A published store to sync from
const sourceOf = (collections: Record<string, CollectionItem[]>, media: SourceMedia[] = []): ContentSource => ({
  getCollections: async () => collections,
  getMedia: async () => media
});
const snippet = (key: string, text: string, media?: string[]): CollectionItem => ({
  id: `s_${key}`,
  key,
  translations: { en: { text } },
  ...(media ? { media } : {})
});
const image = (virtualPath: string, bytes: Uint8Array): SourceMedia => ({ virtualPath, content: Buffer.from(bytes), mimeType: "image/png" });
const offline: RemoteDownloader = {
  fetchChannelManifest: async () => { throw new Error("offline"); },
  fetchReleaseManifest: async () => { throw new Error("offline"); },
  fetchObject: async () => { throw new Error("offline"); },
  fetchMedia: async () => { throw new Error("offline"); }
};

describe("ClientStorage contract (G12)", () => {
  let dir: string;
  let factory: IDBFactory;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "cds-storage-contract-"));
    factory = new IDBFactory();
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const storages: [string, () => ClientStorage][] = [
    ["MemoryStorage", () => new MemoryStorage()],
    ["FilesystemStorage", () => new FilesystemStorage(dir)],
    ["IndexedDBStorage", () => new IndexedDBStorage({ indexedDB: factory })]
  ];
  const manifest = (releaseId: string): ReleaseManifest => ({
    schemaVersion: 1,
    releaseId,
    createdAt: "2026-10-18T00:00:00.000Z",
    collections: {},
    media: {}
  });

  it.each(storages)("%s keeps objects, media, releases, channels and the active release", async (_name, make) => {
    const storage = make();
    const text = '{"collection":"snippets","text":"Grüße 🏨"}';
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);

    expect(await storage.hasObject("h1")).toBe(false);
    expect(await storage.readObject("h1")).toBeNull();
    await storage.saveObject("h1", text);
    expect(await storage.hasObject("h1")).toBe(true);
    expect(await storage.readObject("h1")).toBe(text);

    expect(await storage.hasMedia("m1")).toBe(false);
    expect(await storage.readMedia("m1")).toBeNull();
    await storage.saveMedia("m1", bytes);
    expect(await storage.hasMedia("m1")).toBe(true);
    const read = await storage.readMedia("m1");
    expect(read).toBeInstanceOf(Uint8Array);
    expect(Array.from(read!)).toEqual(Array.from(bytes));

    await storage.saveRelease("r2", manifest("r2"));
    await storage.saveRelease("r1", manifest("r1"));
    expect(await storage.listReleases()).toEqual(["r1", "r2"]);
    expect((await storage.readRelease("r1"))?.releaseId).toBe("r1");
    await storage.deleteRelease("r1");
    expect(await storage.listReleases()).toEqual(["r2"]);
    expect(await storage.readRelease("r1")).toBeNull();

    expect(await storage.getActiveReleaseId()).toBeNull();
    await storage.setActiveReleaseId("r2");
    expect(await storage.getActiveReleaseId()).toBe("r2");
    await storage.setActiveReleaseId(null);
    expect(await storage.getActiveReleaseId()).toBeNull();

    const channel = { schemaVersion: 1 as const, channel: "production", releaseId: "r2", updatedAt: "2026-10-18T00:00:00.000Z" };
    expect(await storage.readChannelManifest("production")).toBeNull();
    await storage.saveChannelManifest("production", channel);
    expect(await storage.readChannelManifest("production")).toEqual(channel);
  });

  it("IndexedDBStorage keeps its data across connections", async () => {
    const first = new IndexedDBStorage({ name: "kiosk", indexedDB: factory });
    await first.saveObject("h1", "content");
    await first.setActiveReleaseId("r1");
    first.close();

    const second = new IndexedDBStorage({ name: "kiosk", indexedDB: factory });
    expect(await second.readObject("h1")).toBe("content");
    expect(await second.getActiveReleaseId()).toBe("r1");
    expect(await new IndexedDBStorage({ name: "other", indexedDB: factory }).getActiveReleaseId()).toBeNull();
  });
});

describe("Syncing into IndexedDB (G12)", () => {
  let dir: string;
  let factory: IDBFactory;
  const logo = new Uint8Array(crypto.randomBytes(2048));
  const banner = new Uint8Array(crypto.randomBytes(2048));

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "cds-idb-sync-"));
    factory = new IDBFactory();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const publish = (storeDir: string, releaseId: string, text: string, media: SourceMedia[] = []) =>
    new Publisher(sourceOf({ snippets: [snippet("welcome", text, media.map((m) => m.virtualPath))] }, media), new FilesystemStore(storeDir))
      .publish("production", releaseId);
  const welcome = (client: CDSClient) => client.use("snippets").get("welcome")?.translations.en.text;

  // A fresh client on the same database, without network: what a reloaded page sees
  const reloaded = async (name = "cds") => {
    const client = new CDSClient({ storage: new IndexedDBStorage({ name, indexedDB: factory }), downloader: offline });
    await client.initialize();
    return client;
  };

  it("syncs, verifies and stores a release; a reload without network serves it", async () => {
    await publish(dir, "r1", "Grüße 🏨", [image("logo.png", logo)]);
    const client = new CDSClient({ storage: new IndexedDBStorage({ indexedDB: factory }), downloader: downloaderFor(dir) });
    await client.initialize();
    expect(await client.sync("production")).toMatchObject({ success: true, updated: true, releaseId: "r1" });

    const again = await reloaded();
    expect(again.getActiveRelease()?.releaseId).toBe("r1");
    expect(welcome(again)).toBe("Grüße 🏨");
    const bytes = await again.getMediaContent("logo.png");
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(bytes!)).toEqual(Array.from(logo));
    // a failed sync keeps it
    expect(await again.sync("production")).toMatchObject({ success: false });
    expect(welcome(again)).toBe("Grüße 🏨");
  });

  // r1 is active; r2 then fails in one of three ways
  async function failSecondRelease(storage: (name: string) => IndexedDBStorage, corrupt = false) {
    await publish(dir, "r1", "first");
    const first = new CDSClient({ storage: new IndexedDBStorage({ indexedDB: factory }), downloader: downloaderFor(dir) });
    await first.initialize();
    expect((await first.sync("production")).success).toBe(true);

    const r2 = await publish(dir, "r2", "second", [image("banner.png", banner)]);
    if (corrupt) {
      const hash = r2.manifest.collections.snippets.hash;
      await fs.writeFile(path.join(dir, "objects", `${hash}.json`), '{"tampered":true}');
    }
    const client = new CDSClient({ storage: storage("cds"), downloader: downloaderFor(dir) });
    await client.initialize();
    const result = await client.sync("production");
    expect(result.success).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
    expect(client.getActiveRelease()?.releaseId).toBe("r1");
    expect(welcome(client)).toBe("first");

    const again = await reloaded();
    expect(again.getActiveRelease()?.releaseId).toBe("r1");
    expect(welcome(again)).toBe("first");
    return result.error!;
  }

  it("a corrupt object fails the sync and leaves the previous release active", async () => {
    const error = await failSecondRelease((name) => new IndexedDBStorage({ name, indexedDB: factory }), true);
    expect(error.message).toMatch(/Hash mismatch/);
  });

  it("a full quota fails the sync and leaves the previous release active", async () => {
    class FullStorage extends IndexedDBStorage {
      async saveMedia(): Promise<void> {
        throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      }
    }
    const error = await failSecondRelease((name) => new FullStorage({ name, indexedDB: factory }));
    expect(error.name).toBe("QuotaExceededError");
  });

  it("a write failing in the middle of saving leaves the previous release active", async () => {
    class Interrupted extends IndexedDBStorage {
      async saveRelease(): Promise<void> {
        throw new Error("the tab was closed");
      }
    }
    const error = await failSecondRelease((name) => new Interrupted({ name, indexedDB: factory }));
    expect(error.message).toBe("the tab was closed");
  });

  it("clients syncing at the same time on one database end with one complete active release", async () => {
    const other = await fs.mkdtemp(path.join(os.tmpdir(), "cds-idb-sync-b-"));
    try {
      await publish(dir, "ra", "from a", [image("logo.png", logo)]);
      await publish(other, "rb", "from b", [image("banner.png", banner)]);
      const tab = (storeDir: string) =>
        new CDSClient({ storage: new IndexedDBStorage({ indexedDB: factory }), downloader: downloaderFor(storeDir) });
      const [a1, a2, b] = [tab(dir), tab(dir), tab(other)];
      await Promise.all([a1.initialize(), a2.initialize(), b.initialize()]);
      const results = await Promise.all([a1.sync("production"), b.sync("production"), a2.sync("production")]);
      expect(results.every((r) => r.success)).toBe(true);

      const again = await reloaded();
      const active = again.getActiveRelease()!.releaseId;
      expect(["ra", "rb"]).toContain(active);
      expect(welcome(again)).toBe(active === "ra" ? "from a" : "from b");
      const media = active === "ra" ? ["logo.png", logo] as const : ["banner.png", banner] as const;
      expect(Array.from((await again.getMediaContent(media[0]))!)).toEqual(Array.from(media[1]));
    } finally {
      await fs.rm(other, { recursive: true, force: true });
    }
  });
});
