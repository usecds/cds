import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { Publisher, FilesystemStore, CollectionItem, ContentSource } from "../server/src/index.js";
import { CDSClient, MemoryStorage, EditOverlay, formatAddress, parseAddress } from "../client/src/index.js";
import { downloaderFor } from "./helpers.js";

const sourceOf = (collections: Record<string, CollectionItem[]>): ContentSource => ({
  getCollections: async () => collections,
  getMedia: async () => []
});

const site = (title: string): Record<string, CollectionItem[]> => ({
  _routes: [{ id: "r_home", key: "home", page: "p_home", translations: { en: { path: "/" } } }],
  _pages: [{ id: "p_home", key: "home", blocks: ["b_hero"], translations: { en: { title: "Home" } } }],
  _blocks: [{ id: "b_hero", key: "hero", type: "hero", translations: { en: { title } } }]
});

describe("Field addresses", () => {
  it("round-trip, with ids and paths that need encoding", () => {
    const address = { collection: "_blocks", id: "a/b c", path: "translations.en-gb.title" };
    expect(formatAddress(address)).toBe("_blocks/a%2Fb%20c/translations.en-gb.title");
    expect(parseAddress(formatAddress(address))).toEqual(address);
    expect(parseAddress("only/two")).toBeNull();
  });
});

describe("EditOverlay", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "cds-overlay-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const client = async () => {
    const c = new CDSClient({ storage: new MemoryStorage(), downloader: downloaderFor(dir) });
    await c.initialize();
    return c;
  };

  it("shows unpublished edits in every read, without changing the release", async () => {
    await new Publisher(sourceOf(site("Welcome")), new FilesystemStore(dir)).publish("production", "r1");
    const cds = await client();
    await cds.sync("production");
    const overlay = new EditOverlay();
    cds.setOverlay(overlay);

    overlay.set({ collection: "_blocks", id: "b_hero", path: "translations.en.title", value: "Welcome back" });
    expect((await cds.getItemById("_blocks", "b_hero"))?.translations.en.title).toBe("Welcome back");
    expect((await cds.getPage("p_home", "en"))?.blocks[0].texts.title).toBe("Welcome back");
    expect(cds.getPublishedCollection("_blocks")[0].translations.en.title).toBe("Welcome");

    overlay.delete({ collection: "_blocks", id: "b_hero", path: "translations.en.title" });
    expect((await cds.getItemById("_blocks", "b_hero"))?.translations.en.title).toBe("Welcome");
  });

  it("drops edits a newer release makes redundant: contained, or saved before its source was read", async () => {
    const store = new FilesystemStore(dir);
    const overlay = new EditOverlay();
    overlay.set({ collection: "_blocks", id: "b_hero", path: "translations.en.title", value: "Edited", savedAt: Date.now() - 60_000 });
    overlay.set({ collection: "_pages", id: "p_home", path: "translations.en.title", value: "Home", savedAt: Date.now() + 60_000 });
    overlay.set({ collection: "_pages", id: "p_home", path: "translations.en.description", value: "Later", savedAt: Date.now() + 60_000 });

    const { manifest } = await new Publisher(sourceOf(site("Changed again in the source")), store).publish("production", "r2");
    expect(manifest.sourceReadAt).toBeDefined();
    const cds = await client();
    await cds.sync("production");
    overlay.prune((name) => cds.getPublishedCollection(name), Date.parse(manifest.sourceReadAt!));

    // the first edit is older than the release: the release's value wins, even though it differs
    // the second is newer but the release contains it; the third stays until a release has it
    expect(overlay.list().map((e) => e.path)).toEqual(["translations.en.description"]);
  });
});
