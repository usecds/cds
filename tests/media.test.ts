import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import os from "os";
import { Publisher, FilesystemStore, CollectionItem, ContentSource, SourceMedia } from "../server/src/index.js";
import { CDSClient, MemoryStorage } from "../client/src/index.js";
import { downloaderFor } from "./helpers.js";

const image = (virtualPath: string): SourceMedia => ({
  virtualPath,
  content: Buffer.from(`bytes-of-${virtualPath}`),
  mimeType: "image/jpeg"
});

const sourceOf = (collections: Record<string, CollectionItem[]>, media: SourceMedia[]): ContentSource => ({
  getCollections: async () => collections,
  getMedia: async () => media
});

const suiteDescription = "Corner suite on the fourth floor with a wide view over the lake and the old town.";

const suiteMeta = (): CollectionItem => ({
  id: "rooms/suite.jpg",
  key: "rooms/suite.jpg",
  translations: {
    en: { alt: "Suite with lake view", description: suiteDescription },
    de: { alt: "Suite mit Seeblick", description: "" }
  },
  focalPoint: { x: 0.62, y: 0.4 },
  width: 3000,
  height: 2000
});

describe("Media metadata (G5)", () => {
  let storeDir: string;
  let store: FilesystemStore;

  beforeEach(async () => {
    storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "cds-media-test-"));
    store = new FilesystemStore(storeDir);
  });

  afterEach(async () => {
    await fs.rm(storeDir, { recursive: true, force: true });
  });

  it("treats _media as content: translation completeness and recommendations apply", async () => {
    const { artifacts } = await new Publisher(
      sourceOf({ _media: [suiteMeta()] }, [image("rooms/suite.jpg")]),
      store
    ).publish("production", "r1", { sourceLocale: "en" });

    expect(artifacts.translations.collections._media.de).toEqual({ expected: 2, translated: 1, missing: 1, stale: 0, machine: 0 });
    const issues = artifacts.content.issues.map(({ issue, locale, field }) => ({ issue, locale, field }));
    expect(issues).toEqual([
      { issue: "untranslated", locale: "de", field: "description" },
      { issue: "missing", locale: "de", field: "description" }
    ]);
  });

  it("exposes media files with their metadata on the client", async () => {
    await new Publisher(
      sourceOf({ _media: [suiteMeta()] }, [image("rooms/suite.jpg"), image("logo.png")]),
      store
    ).publish("production", "r1", { sourceLocale: "en" });

    const client = new CDSClient({ storage: new MemoryStorage(), downloader: downloaderFor(storeDir) });
    expect((await client.sync("production")).success).toBe(true);

    const en = client.getMediaInfo("rooms/suite.jpg", "en");
    expect(en).toMatchObject({
      path: "rooms/suite.jpg",
      mimeType: "image/jpeg",
      width: 3000,
      height: 2000,
      focalPoint: { x: 0.62, y: 0.4 },
      alt: "Suite with lake view",
      description: suiteDescription
    });
    expect(en?.size).toBe(Buffer.byteLength("bytes-of-rooms/suite.jpg"));

    // Empty texts are left out; no locale means no texts
    const de = client.getMediaInfo("rooms/suite.jpg", "de");
    expect(de?.alt).toBe("Suite mit Seeblick");
    expect(de).not.toHaveProperty("description");
    expect(client.getMediaInfo("rooms/suite.jpg")).not.toHaveProperty("alt");

    // Media without metadata, and unknown paths
    expect(client.getMediaInfo("logo.png", "en")).toEqual({
      path: "logo.png",
      hash: expect.any(String),
      size: Buffer.byteLength("bytes-of-logo.png"),
      mimeType: "image/jpeg"
    });
    expect(client.getMediaInfo("missing.jpg", "en")).toBeNull();
  });

  it("rejects invalid _media items before writing anything", async () => {
    const publish = (meta: object[], media = [image("rooms/suite.jpg")]) =>
      new Publisher(sourceOf({ _media: meta as CollectionItem[] }, media), store).publish("production", "r1");

    await expect(publish([{ ...suiteMeta(), id: "rooms/other.jpg", key: "rooms/other.jpg" }]))
      .rejects.toThrow(/rooms\/other.jpg\): no media file with this virtual path/);
    await expect(publish([{ ...suiteMeta(), focalPoint: { x: 1.5, y: 0.4 } }]))
      .rejects.toThrow(/Invalid _media item \(rooms\/suite.jpg\).*focalPoint\/x/);
    await expect(publish([{ ...suiteMeta(), width: 0 }]))
      .rejects.toThrow(/Invalid _media item.*width/);
    await expect(publish([suiteMeta(), suiteMeta()]))
      .rejects.toThrow(/described more than once/);

    expect(existsSync(path.join(storeDir, "objects"))).toBe(false);
  });
});
