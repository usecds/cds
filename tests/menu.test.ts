import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { Publisher, FilesystemStore, CollectionItem, ContentSource } from "../server/src/index.js";
import { CDSClient, MemoryStorage } from "../client/src/index.js";
import { downloaderFor } from "./helpers.js";

const sourceOf = (collections: Record<string, CollectionItem[]>): ContentSource => ({
  getCollections: async () => collections,
  getMedia: async () => []
});

const label = (en: string, de?: string) => ({ en: { label: en }, ...(de ? { de: { label: de } } : {}) });

const site = (): Record<string, CollectionItem[]> => ({
  _routes: [
    { id: "r_home", key: "home", page: "p_home", translations: { en: { path: "/" }, de: { path: "/de/" } } },
    { id: "r_about", key: "about", page: "p_about", translations: { en: { path: "/about/" } } }
  ],
  _pages: [
    { id: "p_home", key: "home", blocks: ["b_hero", "b_goals"], translations: { en: {} } },
    { id: "p_about", key: "about", blocks: [], translations: { en: {} } }
  ],
  _blocks: [
    { id: "b_hero", key: "hero", type: "hero", links: ["l_goals", "l_github"], translations: { en: {} } },
    { id: "b_goals", key: "goals", type: "list", translations: { en: {} } }
  ],
  _menu: [
    { id: "m_main", key: "main", children: ["l_home", "l_more", "l_github"], translations: { en: {} } },
    { id: "l_home", key: "home", link: { route: "r_home" }, translations: label("Home", "Start") },
    { id: "l_more", key: "more", children: ["l_goals", "l_about"], translations: label("More", "Mehr") },
    { id: "l_goals", key: "goals", link: { route: "r_home", block: "b_goals" }, translations: label("Goals", "Ziele") },
    { id: "l_about", key: "about", link: { route: "r_about" }, translations: label("About", "Über uns") },
    { id: "l_github", key: "github", link: { url: "https://github.com/example/cds" }, translations: label("GitHub", "GitHub") }
  ]
});

describe("Menus and links (G8)", () => {
  let storeDir: string;

  beforeEach(async () => {
    storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "cds-menu-test-"));
  });

  afterEach(async () => {
    await fs.rm(storeDir, { recursive: true, force: true });
  });

  const publish = (collections: Record<string, CollectionItem[]>) =>
    new Publisher(sourceOf(collections), new FilesystemStore(storeDir)).publish("production", "r1", { sourceLocale: "en" });

  it("builds nested menus with localized labels and hrefs", async () => {
    await publish(site());
    const client = new CDSClient({ storage: new MemoryStorage(), downloader: downloaderFor(storeDir) });
    expect((await client.sync("production")).success).toBe(true);

    expect(client.getMenu("main", "en")).toEqual([
      { id: "l_home", key: "home", label: "Home", href: "/", external: false, children: [] },
      {
        id: "l_more", key: "more", label: "More", external: false, children: [
          { id: "l_goals", key: "goals", label: "Goals", href: "/#goals", external: false, children: [] },
          { id: "l_about", key: "about", label: "About", href: "/about/", external: false, children: [] }
        ]
      },
      { id: "l_github", key: "github", label: "GitHub", href: "https://github.com/example/cds", external: true, children: [] }
    ]);

    // "About" has no German path, so it's left out of the German menu
    const de = client.getMenu("main", "de")!;
    expect(de.map((e) => e.label)).toEqual(["Start", "Mehr", "GitHub"]);
    expect(de[1].children.map((e) => `${e.label} ${e.href}`)).toEqual(["Ziele /de/#goals"]);

    // Block links use the same link items
    expect(client.resolveLink("l_goals", "de")).toMatchObject({ label: "Ziele", href: "/de/#goals" });
    expect(client.getMenu("footer", "en")).toBeNull();
  });

  it("rejects broken menus and links before writing anything", async () => {
    const broken = (change: (s: Record<string, CollectionItem[]>) => void) => {
      const s = site();
      change(s);
      return publish(s);
    };
    const menu = (s: Record<string, CollectionItem[]>, id: string) => s._menu.find((m) => m.id === id)!;

    await expect(broken((s) => { menu(s, "m_main").children!.push("l_missing"); })).rejects.toThrow(/unknown child "l_missing"/);
    await expect(broken((s) => { menu(s, "l_goals").children = ["l_more"]; })).rejects.toThrow(/Menu cycle/);
    await expect(broken((s) => { menu(s, "l_home").link = { route: "r_home", url: "https://x.org" }; })).rejects.toThrow(/either a route or a url/);
    await expect(broken((s) => { menu(s, "l_github").link = { url: "/relative" }; })).rejects.toThrow(/url must be absolute/);
    await expect(broken((s) => { menu(s, "l_home").link = { route: "r_missing" }; })).rejects.toThrow(/unknown route "r_missing"/);
    await expect(broken((s) => { menu(s, "l_goals").link = { route: "r_about", block: "b_goals" }; })).rejects.toThrow(/isn't on the page of route "r_about"/);
    await expect(broken((s) => { s._blocks[0].links = ["l_missing"]; })).rejects.toThrow(/unknown _menu link "l_missing"/);
    await expect(broken((s) => {
      // main -> l1 -> l2 -> l3 -> l4: four levels
      s._menu.push(
        { id: "l1", key: "l1", children: ["l2"], translations: label("1") },
        { id: "l2", key: "l2", children: ["l3"], translations: label("2") },
        { id: "l3", key: "l3", children: ["l4"], translations: label("3") },
        { id: "l4", key: "l4", link: { route: "r_home" }, translations: label("4") }
      );
      menu(s, "m_main").children!.push("l1");
    })).rejects.toThrow(/nested deeper than 3 levels/);
  });

  it("reports entries without any label", async () => {
    const s = site();
    s._menu.find((m) => m.id === "l_about")!.translations = { en: {} };
    const { artifacts } = await publish(s);
    expect(artifacts.content.issues).toContainEqual(expect.objectContaining({ issue: "missing-label", collection: "_menu", id: "l_about" }));
  });
});
