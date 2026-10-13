import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { Publisher, FilesystemStore, CollectionItem, ContentSource } from "../server/src/index.js";
import { CDSClient, MemoryStorage, EditOverlay } from "../client/src/index.js";
import { downloaderFor } from "./helpers.js";

const sourceOf = (collections: Record<string, CollectionItem[]>): ContentSource => ({
  getCollections: async () => collections,
  getMedia: async () => []
});

const snippet = (key: string, text: string): CollectionItem => ({ id: `s_${key}`, key, kind: "text", translations: { en: { text } } });

describe("CDSClient.use", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "cds-use-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const publish = (releaseId: string, collections: Record<string, CollectionItem[]>) =>
    new Publisher(sourceOf(collections), new FilesystemStore(dir)).publish("production", releaseId);

  const client = async () => {
    const c = new CDSClient({ storage: new MemoryStorage(), downloader: downloaderFor(dir) });
    await c.initialize();
    return c;
  };

  it("reads items by key from one collection", async () => {
    await publish("r1", {
      snippets: [snippet("contact-info", "Call us"), snippet("footer", "Bye")],
      qrcodes: [{ id: "q_wifi", key: "wifi", kind: "wifi", ssid: "hotel1", translations: {} }]
    });
    const c = await client();
    await c.sync("production");

    const snippets = c.use("snippets");
    expect(snippets.collection).toBe("snippets");
    expect(snippets.get("contact-info")?.translations.en.text).toBe("Call us");
    expect(snippets.has("footer")).toBe(true);
    expect(snippets.get("wifi")).toBeNull();
    expect(snippets.all().map((i) => i.key)).toEqual(["contact-info", "footer"]);
    expect(c.use("qrcodes").get("wifi")?.ssid).toBe("hotel1");
  });

  it("handles don't affect each other", async () => {
    await publish("r1", { a: [snippet("x", "from a")], b: [snippet("x", "from b")] });
    const c = await client();
    await c.sync("production");

    const a = c.use("a");
    const b = c.use("b");
    // interleaved, as two components rendering at the same time would
    expect(a.get("x")?.translations.en.text).toBe("from a");
    expect(b.get("x")?.translations.en.text).toBe("from b");
    expect(a.get("x")?.translations.en.text).toBe("from a");
  });

  it("a handle taken before a sync reads the new release", async () => {
    const c = await client();
    const snippets = c.use("snippets");
    expect(snippets.get("contact-info")).toBeNull();
    expect(snippets.all()).toEqual([]);

    await publish("r1", { snippets: [snippet("contact-info", "Old")] });
    await c.sync("production");
    expect(snippets.get("contact-info")?.translations.en.text).toBe("Old");

    await publish("r2", { snippets: [snippet("contact-info", "New")] });
    await c.sync("production");
    expect(snippets.get("contact-info")?.translations.en.text).toBe("New");
  });

  it("unknown collections and keys give null", async () => {
    await publish("r1", { snippets: [snippet("contact-info", "Call us")] });
    const c = await client();
    await c.sync("production");
    expect(c.use("nope").get("contact-info")).toBeNull();
    expect(c.use("nope").has("contact-info")).toBe(false);
    expect(c.use("snippets").get("nope")).toBeNull();
  });

  it("sees preview edits from the overlay", async () => {
    await publish("r1", { snippets: [snippet("contact-info", "Call us")] });
    const c = await client();
    await c.sync("production");
    const overlay = new EditOverlay();
    c.setOverlay(overlay);
    overlay.set({ collection: "snippets", id: "s_contact-info", path: "translations.en.text", value: "Edited" });
    expect(c.use("snippets").get("contact-info")?.translations.en.text).toBe("Edited");
  });
});
