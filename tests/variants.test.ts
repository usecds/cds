import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import os from "os";
import sharp from "sharp";
import { Publisher, FilesystemStore, CollectionItem, ContentSource, MediaRenderer, SourceMedia, TargetDefinition } from "../server/src/index.js";
import { CDSClient, MemoryStorage } from "../client/src/index.js";
import { createRenderer } from "../imaging/src/index.js";
import { downloaderFor } from "./helpers.js";

const image = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: "#3366cc" } }).jpeg().toBuffer();

const target: TargetDefinition = {
  id: "screens",
  scope: ["rooms"],
  collections: { rooms: { presets: ["card"] } },
  media: {
    breakpoints: { small: 0, large: 1024 },
    dpr: [1, 2],
    presets: { card: { aspect: "4:3", fit: "fill", widths: { small: 200, large: 400 }, formats: ["webp", "jpeg"] } }
  }
};

describe("Image sizes rendered at release (P19)", () => {
  let dir: string;
  let media: SourceMedia[];
  let collections: Record<string, CollectionItem[]>;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "cds-variants-"));
    media = [
      { virtualPath: "rooms/suite.jpg", content: await image(1600, 1000), mimeType: "image/jpeg" },
      { virtualPath: "logo.svg", content: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), mimeType: "image/svg+xml" }
    ];
    collections = {
      rooms: [{ id: "suite", key: "suite", media: ["rooms/suite.jpg", "logo.svg"], translations: { en: { name: "Suite" } } }],
      _media: [{ id: "rooms/suite.jpg", key: "suite", focalPoint: { x: 0.8, y: 0.5 }, translations: { en: { alt: "The suite" } } }]
    };
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const source = (): ContentSource => ({ getCollections: async () => collections, getMedia: async () => media });
  const publish = (renderer?: MediaRenderer) =>
    new Publisher(source(), new FilesystemStore(dir)).publish("production", "r1", { targets: [target], ...(renderer ? { renderer } : {}) });

  it("renders each preset size per breakpoint, DPR and format, lists them on _media and the client returns them", async () => {
    const { manifest } = await publish(createRenderer());
    const variants = Object.keys(manifest.media).filter((p) => p.includes("@")).sort();
    // 2 breakpoints × 2 DPR = widths 200, 400, 800 (400 twice: small@2x and large@1x share a file) × 2 formats
    expect(variants).toEqual([
      "rooms/suite.jpg@card-200w.jpg",
      "rooms/suite.jpg@card-200w.webp",
      "rooms/suite.jpg@card-400w.jpg",
      "rooms/suite.jpg@card-400w.webp",
      "rooms/suite.jpg@card-800w.jpg",
      "rooms/suite.jpg@card-800w.webp"
    ]);
    expect(manifest.media["rooms/suite.jpg@card-800w.webp"].mimeType).toBe("image/webp");
    // Vector images are published as they are
    expect(Object.keys(manifest.media).some((p) => p.startsWith("logo.svg@"))).toBe(false);

    const client = new CDSClient({ storage: new MemoryStorage(), downloader: downloaderFor(dir) });
    await client.initialize();
    await client.sync("production");
    const info = client.getMediaInfo("rooms/suite.jpg", "en")!;
    expect(info.alt).toBe("The suite");
    expect(info.variants?.length).toBe(8);
    expect(info.variants?.find((v) => v.breakpoint === "large" && v.dpr === 2 && v.format === "webp")).toEqual({
      path: "rooms/suite.jpg@card-800w.webp",
      preset: "card",
      breakpoint: "large",
      dpr: 2,
      width: 800,
      height: 600,
      format: "webp"
    });
    const rendered = await client.getMediaContent("rooms/suite.jpg@card-800w.webp");
    expect(await sharp(rendered!).metadata()).toMatchObject({ width: 800, height: 600, format: "webp" });
  });

  it("publishes only originals without a renderer", async () => {
    const { manifest } = await publish();
    expect(Object.keys(manifest.media).sort()).toEqual(["logo.svg", "rooms/suite.jpg"]);
  });

  it("a failed render fails the publish before anything is written", async () => {
    const failing: MediaRenderer = { render: async () => { throw new Error("out of memory"); } };
    await expect(publish(failing)).rejects.toThrow(/Rendering rooms\/suite.jpg@card-\d+w\.\w+ failed: out of memory/);
    expect(existsSync(path.join(dir, "objects"))).toBe(false);
    expect(existsSync(path.join(dir, "channels"))).toBe(false);
  });

  it("with a cache folder, an unchanged image isn't rendered again", async () => {
    const cacheDir = path.join(dir, "cache");
    let renders = 0;
    const counting = (inner: MediaRenderer): MediaRenderer => ({
      render: async (src, request) => {
        const before = (await fs.readdir(cacheDir).catch(() => [])).length;
        const out = await inner.render(src, request);
        if ((await fs.readdir(cacheDir)).length > before) renders++;
        return out;
      }
    });
    await publish(counting(createRenderer({ cacheDir })));
    expect(renders).toBe(6);
    renders = 0;
    const { manifest } = await new Publisher(source(), new FilesystemStore(dir)).publish("production", "r2", { targets: [target], renderer: counting(createRenderer({ cacheDir })) });
    expect(renders).toBe(0);
    expect(Object.keys(manifest.media).length).toBe(8);
  });
});
