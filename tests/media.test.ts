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

// An item that references media in all locales
const roomsUsing = (...media: string[]): CollectionItem[] => [
  { id: "suite", key: "suite", translations: { en: {} }, media }
];

const suiteDescription = "Corner suite on the fourth floor with a wide view over the lake and the old town.";

const suiteMeta = (): CollectionItem => ({
  id: "rooms/suite.jpg",
  key: "rooms/suite.jpg",
  translations: {
    en: { alt: "Suite with lake view", description: suiteDescription },
    de: { alt: "Suite mit Seeblick", description: "" }
  },
  focalPoint: { x: 0.62, y: 0.4 },
  focalPoints: { bed: { x: 0.3, y: 0.7 }, window: { x: 0.8, y: 0.35 } },
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
      sourceOf({ rooms: roomsUsing("rooms/suite.jpg"), _media: [suiteMeta()] }, [image("rooms/suite.jpg")]),
      store
    ).publish("production", "r1", { sourceLocale: "en" });

    expect(artifacts.translations.collections._media.de).toEqual({ expected: 2, translated: 1, missing: 1, stale: 0, machine: 0 });
    const issues = artifacts.content.issues.map(({ issue, locale, field }) => ({ issue, locale, field }));
    expect(issues).toEqual([
      { issue: "untranslated", locale: "de", field: "description" },
      { issue: "missing", locale: "de", field: "description" }
    ]);
  });

  it("publishes only referenced media and reports the rest", async () => {
    const unusedMeta = { ...suiteMeta(), id: "unused.jpg", key: "unused.jpg" };
    const { manifest, artifacts } = await new Publisher(
      sourceOf(
        { rooms: roomsUsing("rooms/suite.jpg", "missing.jpg"), _media: [suiteMeta(), unusedMeta] },
        [image("rooms/suite.jpg"), image("unused.jpg")]
      ),
      store
    ).publish("production", "r1", { sourceLocale: "en" });

    expect(Object.keys(manifest.media)).toEqual(["rooms/suite.jpg"]);
    expect(manifest.collections._media.itemCount).toBe(1);
    expect(await store.listMedia()).toHaveLength(1);
    expect(artifacts.content.warnings).toEqual([
      "Media unused.jpg is not referenced by any item and was not published",
      "_media entry unused.jpg was ignored because the media isn't published",
      "Media missing.jpg is referenced but not provided by the source"
    ]);
  });

  it("expects texts of language-specific media only in the locales that use it", async () => {
    // The page shows a different diagram per locale
    const pages: CollectionItem[] = [{
      id: "home",
      key: "home",
      translations: {
        en: { title: "Home", media: ["flow.png"] },
        de: { title: "Start", media: ["flow-de.png"] }
      }
    }];
    const _media: CollectionItem[] = [
      { id: "flow.png", key: "flow.png", translations: { en: { alt: "Pipeline diagram" } } },
      { id: "flow-de.png", key: "flow-de.png", translations: { de: { alt: "Pipeline-Diagramm" } } }
    ];

    const { manifest, artifacts } = await new Publisher(
      sourceOf({ pages, _media }, [image("flow.png"), image("flow-de.png")]),
      store
    ).publish("production", "r1", { sourceLocale: "en" });

    expect(Object.keys(manifest.media).sort()).toEqual(["flow-de.png", "flow.png"]);
    // English image isn't expected in German; the German image isn't a translation at all
    expect(artifacts.translations.collections._media.de).toEqual({ expected: 0, translated: 0, missing: 0, stale: 0, machine: 0 });
    expect(artifacts.translations.itemsWithoutSource).toEqual([]);
    // Only the missing descriptions are recommended, each in its own locale
    const issues = artifacts.content.issues.map(({ id, issue, locale, field }) => ({ id, issue, locale, field }));
    expect(issues).toEqual([
      { id: "flow.png", issue: "missing", locale: "en", field: "description" },
      { id: "flow-de.png", issue: "missing", locale: "de", field: "description" }
    ]);
  });

  it("exposes media files with their metadata on the client", async () => {
    await new Publisher(
      sourceOf(
        { rooms: roomsUsing("rooms/suite.jpg", "logo.png"), _media: [suiteMeta()] },
        [image("rooms/suite.jpg"), image("logo.png")]
      ),
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
      focalPoints: { bed: { x: 0.3, y: 0.7 }, window: { x: 0.8, y: 0.35 } },
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
    const publish = (meta: object[]) =>
      new Publisher(
        sourceOf({ rooms: roomsUsing("rooms/suite.jpg"), _media: meta as CollectionItem[] }, [image("rooms/suite.jpg")]),
        store
      ).publish("production", "r1");

    await expect(publish([{ ...suiteMeta(), focalPoint: { x: 1.5, y: 0.4 } }]))
      .rejects.toThrow(/Invalid _media item \(rooms\/suite.jpg\).*focalPoint\/x/);
    await expect(publish([{ ...suiteMeta(), focalPoints: { window: { x: 0.5 } } }]))
      .rejects.toThrow(/Invalid _media item.*focalPoints\/window/);
    await expect(publish([{ ...suiteMeta(), width: 0 }]))
      .rejects.toThrow(/Invalid _media item.*width/);
    await expect(publish([suiteMeta(), suiteMeta()]))
      .rejects.toThrow(/described more than once/);

    expect(existsSync(path.join(storeDir, "objects"))).toBe(false);
  });
});
