import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import os from "os";
import {
  Publisher,
  FilesystemStore,
  CollectionItem,
  ContentSource,
  SourceMap,
  TargetDefinition,
  PublishRequirementsError,
  loadTargets,
  resolveTargets
} from "../server/src/index.js";
import { CDSClient, MemoryStorage } from "../client/src/index.js";
import { downloaderFor } from "./helpers.js";

const sourceOf = (collections: Record<string, CollectionItem[]>, sourceMap?: SourceMap): ContentSource => ({
  getCollections: async () => collections,
  getMedia: async () => [],
  ...(sourceMap ? { getSourceMap: async () => sourceMap } : {})
});

const room = (id: string, en: object, de?: object, extra: object = {}): CollectionItem => ({
  id,
  key: id,
  translations: { en, ...(de ? { de } : {}) },
  ...extra
});

const hotelWeb: TargetDefinition = {
  id: "hotel-web",
  scope: ["rooms", "site_settings"],
  locales: { required: ["en", "de"], minCompleteness: 1 },
  collections: {
    rooms: {
      minItems: 1,
      localized: { type: "object", required: ["name", "description"] },
      fields: { type: "object", required: ["amenities"], properties: { amenities: { type: "object" } } }
    }
  },
  items: [{ collection: "site_settings", key: "homepage" }]
};

const validContent = () => ({
  rooms: [
    room("suite", { name: "Suite", description: "Lake view" }, { name: "Suite", description: "Seeblick" }, { amenities: { wifi: true } })
  ],
  site_settings: [room("homepage", { title: "Hotel" }, { title: "Hotel" })]
});

describe("Targets and content report (G4)", () => {
  let storeDir: string;
  let store: FilesystemStore;

  beforeEach(async () => {
    storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "cds-targets-test-"));
    store = new FilesystemStore(storeDir);
  });

  afterEach(async () => {
    await fs.rm(storeDir, { recursive: true, force: true });
  });

  it("applies built-in default recommendations when no targets are given, without failing", async () => {
    const media: CollectionItem[] = [
      room("hero.jpg", { alt: "x".repeat(130), description: "Short" }),
      room("logo.png", { description: "" })
    ];
    const sourceMap: SourceMap = {
      sources: { cms: { baseUrl: "https://cms.example.com/" } },
      collections: {},
      media: { "hero.jpg": { adapter: "cms", id: "7f3a", path: "/admin/files/7f3a" } }
    };

    const { manifest, artifacts } = await new Publisher(sourceOf({ _media: media }, sourceMap), store)
      .publish("production", "r1", { sourceLocale: "en" });

    expect(manifest.targets).toEqual(["default"]);
    expect(artifacts.content.targets.default).toEqual({ satisfied: true, requirements: 0, recommendations: 4 });

    const issues = artifacts.content.issues.map(({ id, field, issue, length, recommended, severity }) =>
      ({ id, field, issue, length, recommended, severity }));
    expect(issues).toEqual([
      { id: "hero.jpg", field: "alt", issue: "too-long", length: 130, recommended: "1–125 characters", severity: "recommendation" },
      { id: "hero.jpg", field: "description", issue: "too-short", length: 5, recommended: "50–300 characters", severity: "recommendation" },
      { id: "logo.png", field: "alt", issue: "missing", length: undefined, recommended: "1–125 characters", severity: "recommendation" },
      { id: "logo.png", field: "description", issue: "missing", length: undefined, recommended: "50–300 characters", severity: "recommendation" }
    ]);
    expect(artifacts.content.issues[0].source).toBe("https://cms.example.com/admin/files/7f3a");
    expect(artifacts.content.issues[0].message).toBe("alt is too long: 130 characters (recommended 1–125 characters)");
  });

  it("fails the build on unmet requirements and writes nothing", async () => {
    const content = {
      rooms: [room("suite", { name: "Suite" }, { name: "Suite" })], // no description, no amenities
      site_settings: [] as CollectionItem[] // homepage missing
    };

    const error = await new Publisher(sourceOf(content), store)
      .publish("production", "r1", { targets: [hotelWeb] })
      .catch((e) => e);

    expect(error).toBeInstanceOf(PublishRequirementsError);
    const failed = (error as PublishRequirementsError).artifacts.content.issues
      .filter((i) => i.severity === "requirement")
      .map(({ target, collection, id, locale, field, issue }) => ({ target, collection, id, locale, field, issue }));
    expect(failed).toEqual([
      { target: "hotel-web", collection: "rooms", id: "suite", locale: "en", field: "description", issue: "missing" },
      { target: "hotel-web", collection: "rooms", id: "suite", locale: "de", field: "description", issue: "missing" },
      { target: "hotel-web", collection: "rooms", id: "suite", locale: undefined, field: "amenities", issue: "missing" },
      { target: "hotel-web", collection: "site_settings", id: undefined, locale: undefined, field: undefined, issue: "missing-item" }
    ]);
    expect((error as Error).message).toMatch(/4 unmet target requirement/);
    expect(existsSync(path.join(storeDir, "objects"))).toBe(false);
    expect(existsSync(path.join(storeDir, "channels"))).toBe(false);
  });

  it("publishes when requirements are met and records the satisfied targets", async () => {
    const { manifest, artifacts } = await new Publisher(sourceOf(validContent()), store)
      .publish("production", "r1", { targets: [hotelWeb] });

    expect(manifest.targets).toEqual(["default", "hotel-web"]);
    expect(artifacts.content.targets["hotel-web"]).toEqual({ satisfied: true, requirements: 0, recommendations: 0 });
  });

  it("measures locale thresholds only within the target's scope", async () => {
    const content = {
      ...validContent(),
      news: [room("n1", { title: "News" })] // untranslated, but outside hotel-web's scope
    };
    const { artifacts } = await new Publisher(sourceOf(content), store)
      .publish("production", "r1", { targets: [hotelWeb] });
    expect(artifacts.content.targets["hotel-web"].satisfied).toBe(true);
    expect(artifacts.content.issues).toContainEqual(expect.objectContaining({
      severity: "recommendation", issue: "untranslated", collection: "news", id: "n1", locale: "de", field: "title"
    }));

    const strictDefault: TargetDefinition = { id: "default", locales: { minCompleteness: 1 } };
    await expect(new Publisher(sourceOf(content), store)
      .publish("production", "r2", { targets: [strictDefault, hotelWeb] })).rejects.toThrow(/de is 75% translated, 100% required/);
  });

  it("fails every named target when the default target fails", async () => {
    const defaultTarget: TargetDefinition = { id: "default", items: [{ collection: "site_settings", key: "legal" }] };
    const error = await new Publisher(sourceOf(validContent()), store)
      .publish("production", "r1", { targets: [defaultTarget, hotelWeb] })
      .catch((e) => e as PublishRequirementsError);
    expect(error.artifacts.content.targets).toEqual({
      default: { satisfied: false, requirements: 1, recommendations: 0 },
      "hotel-web": { satisfied: false, requirements: 0, recommendations: 0 }
    });
  });

  it("merges named targets with the default additively", () => {
    const defaultTarget: TargetDefinition = {
      id: "default",
      locales: { required: ["en"], minCompleteness: 0.9, maxStale: 5 },
      collections: { rooms: { minItems: 1, localized: { required: ["name"] } } },
      media: { breakpoints: [768], presets: { card: { aspect: "4:3", fit: "fill" } } }
    };
    const kiosk: TargetDefinition = {
      id: "kiosk",
      locales: { required: ["de"], minCompleteness: 0.5, maxStale: 0 },
      collections: { rooms: { minItems: 3, localized: { required: ["description"] } } },
      media: { breakpoints: [1920, 768], presets: { card: { fit: "fill", aspect: "4:3" }, hero: { aspect: "21:9" } } }
    };

    const { effective } = resolveTargets([defaultTarget, kiosk]);

    expect(effective.kiosk.locales).toEqual({ required: ["en", "de"], minCompleteness: 0.9, maxStale: 0 });
    expect(effective.kiosk.collections?.rooms).toEqual({
      minItems: 3,
      localized: { allOf: [{ required: ["name"] }, { required: ["description"] }] }
    });
    expect(effective.kiosk.media).toEqual({
      breakpoints: [768, 1920],
      presets: { card: { aspect: "4:3", fit: "fill" }, hero: { aspect: "21:9" } }
    });
    expect(effective.default).toBe(defaultTarget);
  });

  it("rejects invalid target combinations", () => {
    const preset = (id: string, fit: string): TargetDefinition => ({ id, media: { presets: { card: { fit } } } });
    expect(() => resolveTargets([preset("a", "fill"), preset("b", "fit")])).toThrow(/Preset "card" is defined differently/);
    expect(() => resolveTargets([{ id: "a" }, { id: "a" }])).toThrow(/Duplicate target id/);
    expect(() => resolveTargets([{ id: "a", scope: ["rooms"], items: [{ collection: "news", key: "x" }] }]))
      .toThrow(/outside its scope: news/);
    expect(() => resolveTargets([{ id: "default", scope: ["rooms"] }])).toThrow(/default target applies to everything/);
    expect(() => resolveTargets([{ id: "bad id!" }])).toThrow(/Invalid Target Definition/);

    const many = Array.from({ length: 9 }, (_, i) => ({ id: `t${i}` }));
    expect(resolveTargets(many).warnings).toEqual(["9 named targets; the recommended maximum is 8"]);
  });

  it("loads target definitions from a folder", async () => {
    const dir = path.join(storeDir, "targets");
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "default.json"), JSON.stringify({ id: "default", locales: { required: ["en"] } }));
    await fs.writeFile(path.join(dir, "hotel-web.json"), JSON.stringify(hotelWeb));

    const targets = await loadTargets(dir);
    expect(targets.map((t) => t.id)).toEqual(["default", "hotel-web"]);

    await fs.writeFile(path.join(dir, "kiosk.json"), JSON.stringify({ id: "default" }));
    await expect(loadTargets(dir)).rejects.toThrow(/only default.json may/);
  });

  it("client refuses releases that don't satisfy or don't list its target", async () => {
    await new Publisher(sourceOf(validContent()), store).publish("production", "r1"); // default only

    const kioskClient = new CDSClient({ storage: new MemoryStorage(), downloader: downloaderFor(storeDir), target: "hotel-web" });
    const refused = await kioskClient.sync("production");
    expect(refused.success).toBe(false);
    expect(refused.error?.message).toMatch(/does not satisfy target hotel-web/);
    expect(kioskClient.getActiveRelease()).toBeNull();

    await new Publisher(sourceOf(validContent()), store).publish("production", "r2", { targets: [hotelWeb] });
    const accepted = await kioskClient.sync("production");
    expect(accepted).toMatchObject({ success: true, releaseId: "r2" });
  });
});
