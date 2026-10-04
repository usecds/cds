import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { Publisher, FilesystemStore, CollectionItem, ContentSource, SourceMedia } from "../server/src/index.js";
import { CDSClient, MemoryStorage } from "../client/src/index.js";
import { downloaderFor } from "./helpers.js";

const sourceOf = (collections: Record<string, CollectionItem[]>, media: SourceMedia[] = []): ContentSource => ({
  getCollections: async () => collections,
  getMedia: async () => media
});

const hotels: CollectionItem[] = [{
  id: "h1",
  key: "bern",
  translations: { en: { name: "Hotel Bern" }, de: { name: "Hotel Bern" } },
  references: [{ collection: "rooms", id: "r1" }]
}];

const rooms: CollectionItem[] = [
  {
    id: "r1",
    key: "suite",
    translations: { en: { name: "Suite with lake view", bed: "King" }, de: { name: "Suite mit Seeblick", bed: "King" } },
    media: ["rooms/suite.jpg"],
    references: [{ collection: "hotels", id: "h1" }],
    size: { value: 48, unit: "MTK" }
  },
  {
    id: "r2",
    key: "penthouse",
    translations: { en: { name: "Penthouse" }, de: { name: "Penthouse" } },
    references: [{ collection: "_jsonld", id: "ld_penthouse" }]
  }
];

const _media: CollectionItem[] = [{
  id: "rooms/suite.jpg",
  key: "rooms/suite.jpg",
  translations: { en: { alt: "Suite with lake view" }, de: { alt: "Suite mit Seeblick" } },
  width: 3000,
  height: 2000
}];

const _jsonld = (): CollectionItem[] => [
  {
    id: "ld_hotel",
    key: "hotel",
    type: "Hotel",
    appliesTo: "hotels",
    values: { address: { "@type": "PostalAddress", streetAddress: "Bahnhofstr. 1", addressLocality: "Bern" } },
    map: { name: "name", containsPlace: "ref:rooms" },
    translations: { en: { description: "City hotel" }, de: { description: "Stadthotel" } }
  },
  {
    id: "ld_room",
    key: "room",
    type: "HotelRoom",
    appliesTo: "rooms",
    values: { bed: { "@type": "BedDetails" } },
    map: { name: "name", "bed.typeOfBed": "bed", "floorSize.value": "size.value", image: "media[0]", containedInPlace: "ref:hotels" },
    translations: { en: {} }
  },
  {
    id: "ld_penthouse",
    key: "penthouse",
    type: "Suite",
    map: { name: "name" },
    translations: { en: {} }
  }
];

const image: SourceMedia = { virtualPath: "rooms/suite.jpg", content: Buffer.from("jpg"), mimeType: "image/jpeg" };

describe("JSON-LD (G6)", () => {
  let storeDir: string;

  beforeEach(async () => {
    storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "cds-jsonld-test-"));
  });

  afterEach(async () => {
    await fs.rm(storeDir, { recursive: true, force: true });
  });

  const publishAndSync = async (collections: Record<string, CollectionItem[]>) => {
    await new Publisher(sourceOf(collections, [image]), new FilesystemStore(storeDir)).publish("production", "r1", { sourceLocale: "en" });
    const client = new CDSClient({ storage: new MemoryStorage(), downloader: downloaderFor(storeDir) });
    expect((await client.sync("production")).success).toBe(true);
    return client;
  };

  it("resolves defaults, localized values, nested keys, images and references one level deep", async () => {
    const client = await publishAndSync({ hotels, rooms, _media, _jsonld: _jsonld() });
    const suite = (await client.getItemById("rooms", "r1"))!;

    expect(await client.getJsonLd("rooms", suite, "de")).toEqual({
      "@context": "https://schema.org",
      "@type": "HotelRoom",
      name: "Suite mit Seeblick",
      bed: { "@type": "BedDetails", typeOfBed: "King" },
      floorSize: { value: 48 },
      image: { "@type": "ImageObject", _media: "rooms/suite.jpg", caption: "Suite mit Seeblick", width: 3000, height: 2000 },
      // The hotel's own ref:rooms isn't followed (one level), so there's no cycle
      containedInPlace: {
        "@type": "Hotel",
        address: { "@type": "PostalAddress", streetAddress: "Bahnhofstr. 1", addressLocality: "Bern" },
        description: "Stadthotel",
        name: "Hotel Bern"
      }
    });
  });

  it("prefers an item's own _jsonld reference over its collection's default", async () => {
    const client = await publishAndSync({ hotels, rooms, _media, _jsonld: _jsonld() });
    const penthouse = (await client.getItemById("rooms", "r2"))!;
    expect(await client.getJsonLd("rooms", penthouse, "en")).toEqual({
      "@context": "https://schema.org",
      "@type": "Suite",
      name: "Penthouse"
    });
    // Collections without a definition get none
    const hotelFree = { id: "x", key: "x", translations: { en: {} } };
    expect(await client.getJsonLd("news", hotelFree, "en")).toBeNull();
  });

  it("rejects invalid definitions before writing anything", async () => {
    const publish = (defs: object[], extra: Record<string, CollectionItem[]> = {}) =>
      new Publisher(sourceOf({ hotels, rooms, _media, _jsonld: defs as CollectionItem[], ...extra }, [image]), new FilesystemStore(storeDir))
        .publish("production", "r1");
    const [hotel, room, penthouse] = _jsonld();

    await expect(publish([{ ...hotel, type: undefined }, room, penthouse])).rejects.toThrow(/Invalid _jsonld item \(ld_hotel\).*type/);
    await expect(publish([{ ...hotel, map: { name: "{{name}}" } }, room, penthouse])).rejects.toThrow(/invalid path "\{\{name\}\}"/);
    await expect(publish([{ ...hotel, map: { brand: "ref:brands" } }, room, penthouse])).rejects.toThrow(/unknown collection "brands"/);
    await expect(publish([hotel, room, penthouse, { ...room, id: "ld_room2" }])).rejects.toThrow(/two JSON-LD defaults: ld_room and ld_room2/);
    await expect(publish([{ ...hotel, appliesTo: "inns" }, room, penthouse])).rejects.toThrow(/appliesTo unknown collection "inns"/);
    await expect(publish([hotel, room])).rejects.toThrow(/references unknown _jsonld definition "ld_penthouse"/);
  });

  it("recommends filling mapped fields that are empty", async () => {
    const { artifacts } = await new Publisher(sourceOf({ hotels, rooms, _media, _jsonld: _jsonld() }, [image]), new FilesystemStore(storeDir))
      .publish("production", "r1", { sourceLocale: "en" });

    const empty = artifacts.content.issues
      .filter((i) => i.issue === "jsonld-empty")
      .map(({ collection, id, locale, field }) => `${collection}/${id} ${locale} ${field}`);
    // The penthouse has no bed, size, image or hotel, but its own definition only maps name
    expect(empty).toEqual([]);

    const sparse = [{ ...rooms[0], translations: { en: { name: "" }, de: { name: "Suite" } }, media: [], size: undefined }];
    const result = await new Publisher(sourceOf({ hotels, rooms: sparse, _media, _jsonld: _jsonld().slice(0, 2) }), new FilesystemStore(storeDir))
      .publish("production", "r2", { sourceLocale: "en" });
    // Per locale, in map order; ref:hotels still resolves
    expect(result.artifacts.content.issues.filter((i) => i.issue === "jsonld-empty").map((i) => `${i.locale} ${i.field}`)).toEqual([
      "de bed",
      "de size.value",
      "de media[0]",
      "en name",
      "en bed",
      "en size.value",
      "en media[0]"
    ]);
    expect(result.artifacts.content.issues.find((i) => i.issue === "jsonld-empty")?.message)
      .toBe("JSON-LD HotelRoom.bed.typeOfBed maps to bed, which is empty");
  });
});
