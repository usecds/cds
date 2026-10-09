import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { Publisher, FilesystemStore, CollectionItem, ContentSource } from "../server/src/index.js";

const sourceOf = (collections: Record<string, CollectionItem[]>): ContentSource => ({
  getCollections: async () => collections,
  getMedia: async () => []
});

const settings = (): Record<string, CollectionItem[]> => ({
  _site: [
    { id: "site", key: "site", defaultLanguage: "en", copyright: "© Example",
      translations: { en: { siteName: "Example" }, de: { siteName: "Beispiel" } } }
  ],
  _languages: [
    { id: "en", key: "en", translations: { en: { name: "English" }, de: { name: "Englisch" } } },
    { id: "de", key: "de", translations: { en: { name: "German" }, de: { name: "Deutsch" } } }
  ],
  _routes: [
    { id: "r_home", key: "home", page: "p_home", translations: { en: { path: "/" }, de: { path: "/de/" } } }
  ],
  _pages: [{ id: "p_home", key: "home", translations: { en: { title: "Home" }, de: { title: "Start" } } }]
});

describe("Site settings and languages (_site, _languages)", () => {
  let storeDir: string;

  beforeEach(async () => {
    storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "cds-settings-test-"));
  });

  afterEach(async () => {
    await fs.rm(storeDir, { recursive: true, force: true });
  });

  const publish = (collections: Record<string, CollectionItem[]>) =>
    new Publisher(sourceOf(collections), new FilesystemStore(storeDir)).publish("production", "r1", { sourceLocale: "en" });
  const broken = (change: (s: Record<string, any[]>) => void) => {
    const s = settings();
    change(s);
    return publish(s);
  };

  it("publishes consistent settings", async () => {
    const result = await publish(settings());
    expect(Object.keys(result.manifest.collections)).toEqual(expect.arrayContaining(["_site", "_languages"]));
  });

  it("checks _site and _languages only when present", async () => {
    await expect(broken((s) => { delete s._site; delete s._languages; })).resolves.toBeDefined();
    // Without _languages, defaultLanguage and route locales aren't checked
    await expect(broken((s) => { delete s._languages; s._site[0].defaultLanguage = "fr"; })).resolves.toBeDefined();
  });

  it("rejects inconsistent settings before writing anything", async () => {
    await expect(broken((s) => { s._site.push({ ...s._site[0], id: "site2", key: "site2" }); })).rejects.toThrow(/_site: needs exactly one item, has 2/);
    await expect(broken((s) => { s._site = []; })).rejects.toThrow(/_site: needs exactly one item, has 0/);
    await expect(broken((s) => { delete s._site[0].translations.de.siteName; })).rejects.toThrow(/Invalid _site item \(site\).*siteName/);
    await expect(broken((s) => { s._site[0].defaultLanguage = "fr"; })).rejects.toThrow(/defaultLanguage "fr" isn't in _languages/);
    await expect(broken((s) => { s._languages[1].key = "German"; })).rejects.toThrow(/Invalid _languages item \(de\)/);
    await expect(broken((s) => { s._languages[1].key = "en"; })).rejects.toThrow(/language "en" is listed twice/);
    await expect(broken((s) => { s._languages.pop(); })).rejects.toThrow(/r_home\): has a path in "de", which isn't in _languages/);
    expect(await fs.readdir(storeDir)).toEqual([]);
  });
});
