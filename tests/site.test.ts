import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import os from "os";
import { Publisher, FilesystemStore, CollectionItem, ContentSource, SourceMedia } from "../server/src/index.js";
import { CDSClient, MemoryStorage } from "../client/src/index.js";
import { downloaderFor } from "./helpers.js";

const sourceOf = (collections: Record<string, CollectionItem[]>, media: SourceMedia[] = []): ContentSource => ({
  getCollections: async () => collections,
  getMedia: async () => media
});

const features: CollectionItem[] = [
  { id: "f1", key: "cas", translations: { en: { title: "CAS" }, de: { title: "CAS" } } },
  { id: "f2", key: "atomic", translations: { en: { title: "Atomic" }, de: { title: "Atomar" } } }
];

const site = (): Record<string, CollectionItem[]> => ({
  features,
  _routes: [
    { id: "r_home", key: "home", page: "p_home", translations: { en: { path: "/" }, de: { path: "/de/" } } },
    { id: "r_about", key: "about", page: "p_about", translations: { en: { path: "/about/" }, de: { path: "/de/ueber-uns/" } } },
    { id: "r_old", key: "old", redirect: "r_older", status: 302, translations: { en: { path: "/old/" } } },
    { id: "r_older", key: "older", redirect: "r_about", translations: { en: { path: "/older/" } } }
  ],
  _pages: [
    { id: "p_home", key: "home", blocks: ["b_hero", "b_features"], translations: { en: { title: "Home", description: "Start" }, de: { title: "Start", description: "Start" } } },
    { id: "p_about", key: "about", blocks: ["b_hero"], translations: { en: { title: "About" }, de: { title: "Über uns" } } }
  ],
  _blocks: [
    {
      id: "b_hero", key: "hero", type: "hero",
      items: [{ collection: "features", id: "f2" }],
      media: ["hero.png"],
      settings: { variant: "large" },
      translations: { en: { title: "Welcome", media: ["diagram.png"] }, de: { title: "Willkommen", media: ["diagram-de.png"] } }
    },
    { id: "b_features", key: "features", type: "card-grid", source: { collection: "features" }, translations: { en: { title: "Features" }, de: { title: "Funktionen" } } }
  ]
});

const media = ["hero.png", "diagram.png", "diagram-de.png"].map((virtualPath) => ({
  virtualPath, content: Buffer.from(virtualPath), mimeType: "image/png"
}));

describe("Routes, pages and blocks (G7)", () => {
  let storeDir: string;

  beforeEach(async () => {
    storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "cds-site-test-"));
  });

  afterEach(async () => {
    await fs.rm(storeDir, { recursive: true, force: true });
  });

  const publish = (collections: Record<string, CollectionItem[]>, releaseId = "r1") =>
    new Publisher(sourceOf(collections, media), new FilesystemStore(storeDir)).publish("production", releaseId, { sourceLocale: "en" });

  it("resolves routes to pages with their blocks, items, localized texts and media", async () => {
    const { manifest } = await publish(site());
    // Block media counts as referenced, so it's published
    expect(Object.keys(manifest.media).sort()).toEqual(["diagram-de.png", "diagram.png", "hero.png"]);

    const client = new CDSClient({ storage: new MemoryStorage(), downloader: downloaderFor(storeDir) });
    expect((await client.sync("production")).success).toBe(true);

    expect(client.getAlternates("r_about")).toEqual({ en: "/about/", de: "/de/ueber-uns/" });
    expect(client.getRoutes().map((r) => r.id)).toEqual(["r_home", "r_about", "r_old", "r_older"]);

    const home = await client.resolveRoute("/de/");
    expect(home?.locale).toBe("de");
    expect(home?.page?.title).toBe("Start");
    expect(home?.page?.blocks.map((b) => b.key)).toEqual(["hero", "features"]);

    const [hero, grid] = home!.page!.blocks;
    expect(hero).toMatchObject({
      type: "hero",
      texts: { title: "Willkommen" },
      media: ["hero.png", "diagram-de.png"],
      settings: { variant: "large" },
      links: []
    });
    expect(hero.items.map((i) => i.item.id)).toEqual(["f2"]);
    // source takes the full collection, in its order
    expect(grid.items.map((i) => `${i.collection}/${i.item.key}`)).toEqual(["features/cas", "features/atomic"]);

    // Redirects are followed to their final target
    expect(await client.resolveRoute("/old/")).toMatchObject({ locale: "en", redirect: { path: "/about/", status: 302 } });
    expect(await client.resolveRoute("/missing/")).toBeNull();
  });

  it("rejects inconsistent site structure before writing anything", async () => {
    const broken = (change: (s: Record<string, CollectionItem[]>) => void) => {
      const s = site();
      change(s);
      return publish(s);
    };

    await expect(broken((s) => { s._routes[0].redirect = "r_about"; })).rejects.toThrow(/needs either a page or a redirect/);
    await expect(broken((s) => { s._routes[0].page = "p_missing"; })).rejects.toThrow(/unknown page "p_missing"/);
    await expect(broken((s) => { s._routes[3].redirect = "r_old"; })).rejects.toThrow(/Redirect cycle/);
    await expect(broken((s) => { s._routes[1].translations.de.path = "/de/"; })).rejects.toThrow(/Path \/de\/ \(de\) is used by routes r_home and r_about/);
    await expect(broken((s) => { s._routes[1].translations = { en: { path: "about" } }; })).rejects.toThrow(/Invalid _routes item \(r_about\).*path/);
    await expect(broken((s) => { s._routes[1].translations = { en: {} }; })).rejects.toThrow(/has no path in any locale/);
    await expect(broken((s) => { s._pages[0].blocks = ["b_missing"]; })).rejects.toThrow(/unknown block "b_missing"/);
    await expect(broken((s) => { s._blocks[0].source = { collection: "features" }; })).rejects.toThrow(/either items or source/);
    await expect(broken((s) => { s._blocks[1].source = { collection: "news" }; })).rejects.toThrow(/source collection "news"/);
    await expect(broken((s) => { s._blocks[0].items = [{ collection: "features", id: "f9" }]; })).rejects.toThrow(/unknown item features\/f9/);
    await expect(broken((s) => { delete (s._blocks[0] as any).type; })).rejects.toThrow(/Invalid _blocks item \(b_hero\).*type/);

    expect(existsSync(path.join(storeDir, "objects"))).toBe(false);
  });

  it("reports unrouted pages, unused blocks, untranslated paths and page metadata", async () => {
    const s = site();
    s._pages.push({ id: "p_draft", key: "draft", blocks: [], translations: { en: { title: "Draft" } } });
    s._blocks.push({ id: "b_spare", key: "spare", type: "text", translations: { en: { title: "Spare" } } });
    const { artifacts } = await publish(s);

    const issues = artifacts.content.issues.map(({ issue, collection, id, locale, field }) =>
      [issue, `${collection}/${id}`, locale, field].filter(Boolean).join(" "));
    expect(issues).toContain("unrouted-page _pages/p_draft");
    expect(issues).toContain("unused-block _blocks/b_spare");
    // Route paths are translatable content: /old/ and /older/ have no German path
    expect(issues).toContain("untranslated _routes/r_old de path");
    // Built-in recommendations for page metadata
    expect(issues).toContain("missing _pages/p_about de description");
    expect(issues).toContain("too-short _pages/p_home en description");
  });

  it("works without any site collections", async () => {
    const { artifacts } = await publish({ features });
    expect(artifacts.content.issues.filter((i) => /page|block|route/.test(i.issue))).toEqual([]);
  });
});
