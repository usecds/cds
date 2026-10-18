import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { Publisher, FilesystemStore, CollectionItem, ContentSource } from "../server/src/index.js";
import { CDSClient, MemoryStorage, localize, resolveLocales } from "../client/src/index.js";
import { downloaderFor } from "./helpers.js";

describe("resolveLocales", () => {
  const available = ["de", "de-AT", "en", "fr-CH"];

  it("tries the locale, its language, the language's regions, then the source locale", () => {
    expect(resolveLocales("de-DE", available, "en")).toEqual(["de-DE", "de", "de-AT", "en"]);
    expect(resolveLocales("de", available, "en")).toEqual(["de", "de-AT", "en"]);
    expect(resolveLocales("fr", available, "en")).toEqual(["fr", "fr-CH", "en"]);
    expect(resolveLocales("it", available, "en")).toEqual(["it", "en"]);
  });

  it("matches without regard to case or separator, and uses the release's spelling", () => {
    expect(resolveLocales("DE_at", available, "en")).toEqual(["de-AT", "de", "en"]);
  });

  it("takes extra fallbacks before the source locale, or none at all", () => {
    expect(resolveLocales("fr-CH", available, "de", { fallback: ["en"] })).toEqual(["fr-CH", "en", "de"]);
    expect(resolveLocales("de-DE", available, "en", { fallback: false })).toEqual(["de-DE"]);
  });
});

describe("localize", () => {
  const item: CollectionItem = {
    id: "s1",
    key: "contact-info",
    kind: "text",
    translations: { en: { text: "Call us", note: "24/7" }, de: { text: "Rufen Sie uns an", note: "" } }
  };

  it("puts each text on the item from the first locale that has it, and says which", () => {
    const de = localize(item, ["de-DE", "de", "en"]);
    expect(de).toEqual({ id: "s1", key: "contact-info", kind: "text", text: "Rufen Sie uns an", note: "24/7", $locales: { text: "de", note: "en" } });
  });

  it("gives null for a text none of the locales has", () => {
    expect(localize(item, ["fr"])).toEqual({ id: "s1", key: "contact-info", kind: "text", text: null, note: null, $locales: {} });
    expect(localize({ ...item, translations: { en: { text: null } } }, ["en"]).text).toBeNull();
  });
});

describe("CDSClient.useLocale", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "cds-locale-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const sourceOf = (collections: Record<string, CollectionItem[]>): ContentSource => ({
    getCollections: async () => collections,
    getMedia: async () => [],
    getSourceLocale: async () => "en"
  });

  it("reads a collection in one language, with fallbacks to the source locale", async () => {
    await new Publisher(sourceOf({
      snippets: [
        { id: "s1", key: "contact-info", translations: { en: { text: "Call us" }, de: { text: "Rufen Sie uns an" } } },
        { id: "s2", key: "footer", translations: { en: { text: "Goodbye" } } }
      ]
    }), new FilesystemStore(dir)).publish("production", "r1");
    const client = new CDSClient({ storage: new MemoryStorage(), downloader: downloaderFor(dir) });
    await client.initialize();

    const de = client.useLocale("de-DE");
    // nothing synced yet: no items, no error
    expect(de.use("snippets").get("contact-info")).toBeNull();
    await client.sync("production");

    expect(de.locales()).toEqual(["de-DE", "de", "en"]);
    const snippets = de.use("snippets");
    expect(snippets.get("contact-info")?.text).toBe("Rufen Sie uns an");
    expect(snippets.get("footer")).toMatchObject({ text: "Goodbye", $locales: { text: "en" } });
    expect(snippets.get("missing")).toBeNull();
    expect(snippets.all().map((i) => i.text)).toEqual(["Rufen Sie uns an", "Goodbye"]);
    expect(client.useLocale("de", { fallback: false }).use("snippets").get("footer")?.text).toBeNull();
  });
});
