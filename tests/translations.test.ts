import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  Publisher,
  FilesystemStore,
  CollectionItem,
  ContentSource,
  translationSourceHash
} from "../server/src/index.js";
import { CDSClient, MemoryStorage, RemoteDownloader } from "../client/src/index.js";

function sourceOf(collections: Record<string, CollectionItem[]>, sourceLocale?: string): ContentSource {
  return {
    getCollections: async () => collections,
    getMedia: async () => [],
    ...(sourceLocale ? { getSourceLocale: async () => sourceLocale } : {})
  };
}

// Reads a FilesystemStore directory directly
function downloaderFor(dir: string): RemoteDownloader {
  const read = (...p: string[]) => fs.readFile(path.join(dir, ...p));
  return {
    fetchChannelManifest: async (channel) => ({ manifest: JSON.parse((await read("channels", channel, "manifest.json")).toString()) }),
    fetchReleaseManifest: async (id) => JSON.parse((await read("releases", `${id}.json`)).toString()),
    fetchObject: async (hash) => (await read("objects", `${hash}.json`)).toString("utf-8"),
    fetchMedia: async (hash, ext) => read("media", `${hash}${ext}`)
  };
}

describe("Translation completeness and provenance (G3)", () => {
  let storeDir: string;
  let store: FilesystemStore;

  beforeEach(async () => {
    storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "cds-translations-test-"));
    store = new FilesystemStore(storeDir);
  });

  afterEach(async () => {
    await fs.rm(storeDir, { recursive: true, force: true });
  });

  it("counts expected, translated and missing fields per collection, locale and overall", async () => {
    const pages: CollectionItem[] = [
      {
        id: "p1",
        key: "home",
        translations: {
          en: { title: "Home", body: "Welcome", empty: "", order: 3, tags: ["a"] },
          de: { title: "Start", body: "" },
          fr: { title: "Accueil", body: null, empty: "x" }
        }
      },
      // No "en" entry: reported, not counted
      { id: "p2", key: "orphan", translations: { de: { title: "Nur Deutsch" } } }
    ];

    const { manifest, artifacts } = await new Publisher(sourceOf({ pages }), store)
      .publish("production", "r1", { sourceLocale: "en" });
    const report = artifacts.translations;

    // Only en.title and en.body are expected: "" and non-string source values are ignored
    expect(report.collections.pages.de).toEqual({ expected: 2, translated: 1, missing: 1, stale: 0, machine: 0 });
    expect(report.collections.pages.fr).toEqual({ expected: 2, translated: 1, missing: 1, stale: 0, machine: 0 });
    expect(report.overall).toEqual({ expected: 4, translated: 2, missing: 2, stale: 0, machine: 0 });
    expect(report.itemsWithoutSource).toEqual([{ collection: "pages", id: "p2" }]);
    expect(report.issues).toEqual([
      { collection: "pages", id: "p1", locale: "de", field: "body", issue: "missing" },
      { collection: "pages", id: "p1", locale: "fr", field: "body", issue: "missing" }
    ]);

    expect(manifest.translations).toEqual({ sourceLocale: "en", locales: report.locales, overall: report.overall });
  });

  it("resolves the source locale: argument, then source, then markers, then en", async () => {
    const plain: CollectionItem[] = [{ id: "a", key: "a", translations: { de: { t: "x" }, fr: { t: "y" } } }];
    const marked: CollectionItem[] = [
      {
        id: "a",
        key: "a",
        translations: { de: { t: "Original" }, en: { t: "Translated" } },
        _translation: { en: { t: { status: "machine", from: "de" } } }
      }
    ];

    let releaseCount = 0;
    const run = async (source: ContentSource, sourceLocale?: string) =>
      (await new Publisher(source, store).publish("production", `r${++releaseCount}`, { sourceLocale })).artifacts.translations;

    expect(await run(sourceOf({ items: plain }, "fr"), "de")).toMatchObject({ sourceLocale: "de", sourceLocaleOrigin: "argument" });
    expect(await run(sourceOf({ items: plain }, "fr"))).toMatchObject({ sourceLocale: "fr", sourceLocaleOrigin: "source" });
    expect(await run(sourceOf({ items: marked }))).toMatchObject({ sourceLocale: "de", sourceLocaleOrigin: "inferred" });
    expect(await run(sourceOf({ items: plain }))).toMatchObject({ sourceLocale: "en", sourceLocaleOrigin: "fallback" });
  });

  it("flags translations as stale when the source text changed after translation (sourceHash)", async () => {
    const items: CollectionItem[] = [
      {
        id: "a",
        key: "a",
        translations: { en: { title: "New title", body: "Body" }, de: { title: "Alter Titel", body: "Text" } },
        _translation: {
          de: {
            title: { status: "machine", from: "en", sourceHash: translationSourceHash("Old title") },
            body: { status: "reviewed", from: "en", sourceHash: translationSourceHash("Body") }
          }
        }
      }
    ];

    const { artifacts } = await new Publisher(sourceOf({ items }), store).publish("production", "r1");
    expect(artifacts.translations.overall).toEqual({ expected: 2, translated: 2, missing: 0, stale: 1, machine: 1 });
    expect(artifacts.translations.issues).toEqual([
      { collection: "items", id: "a", locale: "de", field: "title", issue: "stale" }
    ]);
  });

  it("falls back to the channel's current release to detect stale translations without markers", async () => {
    const version = (en: string, de: string): CollectionItem[] => [
      { id: "a", key: "a", translations: { en: { title: en }, de: { title: de } } }
    ];
    const publish = (releaseId: string, items: CollectionItem[]) =>
      new Publisher(sourceOf({ items }), store).publish("production", releaseId);

    expect((await publish("r1", version("Hello", "Hallo"))).artifacts.translations.overall.stale).toBe(0);
    // Source changed, translation didn't
    expect((await publish("r2", version("Hello world", "Hallo"))).artifacts.translations.overall.stale).toBe(1);
    // Translation updated as well
    expect((await publish("r3", version("Hello again", "Hallo nochmal"))).artifacts.translations.overall.stale).toBe(0);
  });

  it("rejects a malformed _translation marker", async () => {
    const items = [
      { id: "a", key: "a", translations: { en: { t: "x" } }, _translation: { de: { t: { status: "bogus" } } } }
    ] as unknown as CollectionItem[];
    await expect(new Publisher(sourceOf({ items }), store).publish("production", "r1")).rejects.toThrow(/Invalid Collection/);
  });

  it("exposes the summary and per-field status on the client", async () => {
    const items: CollectionItem[] = [
      {
        id: "a",
        key: "a",
        translations: { en: { title: "Changed", body: "Same" }, de: { title: "Titel", body: "Gleich" } },
        _translation: {
          de: {
            title: { status: "human", sourceHash: translationSourceHash("Original") },
            body: { status: "machine", sourceHash: translationSourceHash("Same") }
          }
        }
      }
    ];
    await new Publisher(sourceOf({ items }), store).publish("production", "r1", { sourceLocale: "en" });

    const client = new CDSClient({ storage: new MemoryStorage(), downloader: downloaderFor(storeDir) });
    expect((await client.sync("production")).success).toBe(true);

    expect(client.getTranslationSummary()?.sourceLocale).toBe("en");
    expect(client.getTranslationSummary()?.locales.de.stale).toBe(1);

    const item = (await client.getItemById("items", "a"))!;
    expect(client.getTranslationStatus(item, "de", "title")).toEqual({ status: "human", stale: true });
    expect(client.getTranslationStatus(item, "de", "body")).toEqual({ status: "machine", stale: false });
    expect(client.getTranslationStatus(item, "fr", "title")).toEqual({ status: null, stale: false });
  });
});
