import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  Publisher,
  FilesystemStore,
  CollectionItem,
  ContentSource,
  SourceMedia,
  meaninglessNameReason,
  suggestMediaName
} from "../server/src/index.js";
import { slugify, mediaBaseName, variantFileName } from "../imaging/src/index.js";

describe("Media names", () => {
  it("recognizes meaningless file names and explains why", () => {
    const cases: [string, string][] = [
      ["photo_2026-10-01_12-07-10.png", "messenger default name"],
      ["e3f00826-19e8-4ad9-9b86-68e3a61bc4f4.png", "UUID"],
      ["ChatGPT Image 24. Sept. 2026, 12_41_16.png", "AI tool default name"],
      ["IMG_2034.jpg", "camera default name"],
      ["DSC00012.JPG", "camera default name"],
      ["PXL_20261001_120710123.jpg", "camera default name"],
      ["WhatsApp Image 2026-10-01 at 12.07.10.jpeg", "messenger default name"],
      ["Screenshot 2026-10-01 at 12.07.10.png", "screenshot default name"],
      ["Bildschirmfoto 2026-10-01 um 12.07.10.png", "screenshot default name"],
      ["DALL·E 2026-10-01 12.07.10.png", "AI tool default name"],
      ["Gemini_Generated_Image_abc123def456.png", "AI tool default name"],
      ["9f86d081884c7d659a2feaa0c55ad015.jpg", "hash or random id"],
      ["image1.png", "no descriptive words"],
      ["untitled-copy-final.png", "no descriptive words"],
      ["uploads/2026/10/01.png", "no descriptive words"]
    ];
    for (const [name, reason] of cases) {
      expect(meaninglessNameReason(name), name).toBe(reason);
    }
  });

  it("accepts names with at least one descriptive word", () => {
    for (const name of [
      "coast-with-lighthouse-balloon-sailboat.png",
      "cds-flow-de.png",
      "hero.svg",
      "rooms/suite.jpg",
      "IMG_2034_lighthouse.jpg",
      "team-foto-2026.jpg",
      "DALL·E 2026-10-01 12.07.10 - a lighthouse.png", // the prompt describes it
      "Küstenweg.png"
    ]) {
      expect(meaninglessNameReason(name), name).toBeUndefined();
    }
  });

  it("suggests a name from the alt text", () => {
    expect(suggestMediaName("Rocky coast with a red and white lighthouse, a hot-air balloon"))
      .toBe("rocky-coast-red-white-lighthouse");
    expect(suggestMediaName("Felsige Küste mit rot-weißem Leuchtturm")).toBe("felsige-kueste-rot-weissem-leuchtturm");
  });

  it("builds readable output file names", () => {
    expect(slugify("Küste mit Leuchtturm & Ballon")).toBe("kueste-mit-leuchtturm-ballon");
    expect(mediaBaseName("photos/Coast View.png")).toBe("coast-view");
    expect(mediaBaseName("photos/IMG_2034.png", "Coast Lighthouse")).toBe("coast-lighthouse");
    expect(mediaBaseName("###.png")).toBe("image");
    expect(variantFileName({ base: "coast", preset: "banner", width: 1152, key: "76714bc61495f48c", format: "avif" }))
      .toBe("coast-banner-1152.76714bc6.avif");
    expect(variantFileName({ base: "coast", preset: "banner", key: "76714bc61495f48c", format: "jpeg" }))
      .toBe("coast-banner.76714bc6.jpg");
    expect(variantFileName({ base: "hero", key: "3a9c01d2ffff", format: "svg" })).toBe("hero.3a9c01d2.svg");
  });

  describe("in the content report", () => {
    let storeDir: string;
    beforeEach(async () => {
      storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "cds-names-test-"));
    });
    afterEach(async () => {
      await fs.rm(storeDir, { recursive: true, force: true });
    });

    const image = (virtualPath: string): SourceMedia => ({ virtualPath, content: Buffer.from(virtualPath), mimeType: "image/png" });
    const sourceOf = (collections: Record<string, CollectionItem[]>, media: SourceMedia[]): ContentSource => ({
      getCollections: async () => collections,
      getMedia: async () => media
    });

    it("recommends a name for published media with meaningless names, unless _media names it", async () => {
      const files = ["photo_2026-10-01_12-07-10.png", "e3f00826-19e8-4ad9-9b86-68e3a61bc4f4.png", "coast.png"];
      const pages: CollectionItem[] = [{ id: "home", key: "home", translations: { en: {} }, media: files }];
      const _media: CollectionItem[] = [
        { id: files[0], key: files[0], translations: { en: { alt: "Lighthouse on a cliff at sunset" } } },
        { id: files[1], key: files[1], name: "harbour-boats", translations: { en: { alt: "Boats" } } }
      ];

      const { artifacts } = await new Publisher(sourceOf({ pages, _media }, files.map(image)), new FilesystemStore(storeDir))
        .publish("production", "r1", { sourceLocale: "en" });

      const names = artifacts.content.issues.filter((i) => i.issue === "meaningless-name");
      expect(names).toEqual([
        expect.objectContaining({
          severity: "recommendation",
          collection: "_media",
          id: "photo_2026-10-01_12-07-10.png",
          field: "name",
          recommended: "lighthouse-cliff-sunset",
          message: 'File name "photo_2026-10-01_12-07-10.png" doesn\'t describe the image (messenger default name). Set a name in _media, e.g. "lighthouse-cliff-sunset".'
        })
      ]);
    });
  });
});
