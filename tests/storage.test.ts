import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  Publisher,
  FixtureSource,
  FilesystemStore,
  CollectionItem,
  SourceMap
} from "../server/src/index.js";

const item = (id: string, title: string): CollectionItem => ({
  id,
  key: id,
  translations: { en: { title } }
});

const media = (virtualPath: string, content: string) => ({
  virtualPath,
  content: Buffer.from(content),
  mimeType: "image/png"
});

async function listFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));
}

describe("Build artifacts, storage report and GC (G2)", () => {
  let storeDir: string;
  let store: FilesystemStore;

  beforeEach(async () => {
    storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "cds-storage-test-"));
    store = new FilesystemStore(storeDir);
  });

  afterEach(async () => {
    await fs.rm(storeDir, { recursive: true, force: true });
  });

  it("returns the source map as a build artifact and never writes it to the store", async () => {
    const sourceMap: SourceMap = {
      sources: { directus: { baseUrl: "https://cms.internal.example" } },
      collections: {
        pages: {
          source: { adapter: "directus", collection: "site_pages" },
          items: { home: { id: "42", path: "/admin/content/site_pages/42" } }
        }
      },
      media: {
        "hero.png": { adapter: "directus", id: "f-1", path: "/admin/files/f-1" }
      }
    };
    const source = new FixtureSource({ pages: [item("home", "Home")] }, [media("hero.png", "hero")], sourceMap);

    const { artifacts } = await new Publisher(source, store).publish("production", "r1");

    expect(artifacts.sourceMap).toEqual({ releaseId: "r1", ...sourceMap });
    for (const file of await listFiles(storeDir)) {
      const content = await fs.readFile(file);
      expect(content.includes("cms.internal.example")).toBe(false);
      expect(content.includes("/admin/")).toBe(false);
    }
  });

  it("omits the source map when the source provides none", async () => {
    const { artifacts } = await new Publisher(new FixtureSource(), store).publish("production", "r1");
    expect(artifacts.sourceMap).toBeUndefined();
  });

  it("reports per-release usage, diffs, channels and orphans", async () => {
    const big = media("big.png", "x".repeat(1000));
    const small = media("small.png", "y".repeat(10));

    // r1: pages v1 + big + small
    await new Publisher(new FixtureSource({ pages: [item("a", "v1")] }, [big, small]), store, { retentionCount: 2 })
      .publish("production", "r1");
    // r2: pages v2 + small (big dropped)
    await new Publisher(new FixtureSource({ pages: [item("a", "v2")] }, [small]), store, { retentionCount: 2 })
      .publish("production", "r2");

    const publisher = new Publisher(new FixtureSource(), store, { retentionCount: 2 });
    const report = await publisher.analyzeStorage();

    expect(report.releases.map((r) => r.releaseId)).toEqual(["r1", "r2"]);
    const [r1, r2] = report.releases;

    expect(r1.objects).toBe(1);
    expect(r1.media).toBe(2);
    expect(r1.diff).toBeNull();
    // big.png and the v1 pages object are unique to r1
    const r1Pages = (await store.readRelease("r1"))!.collections.pages;
    expect(r1.uniqueBytes).toBe(1000 + r1Pages.size);

    expect(r2.channels).toEqual(["production"]);
    expect(r1.channels).toEqual([]);
    expect(r2.diff?.previousReleaseId).toBe("r1");
    expect(r2.diff?.shared).toBe(1); // small.png
    expect(r2.diff?.added).toHaveLength(1); // pages v2
    expect(r2.diff?.removed).toHaveLength(2); // pages v1, big.png
    expect(r2.missing).toEqual([]);

    expect(report.channels).toEqual({ production: { releaseId: "r2", retained: true } });
    expect(report.totals).toEqual({ objects: 2, media: 2, bytes: r1.bytes + r2.bytes - 10 });
    expect(report.orphans.files).toEqual([]);
  });

  it("dry-run GC deletes nothing; a real run deletes exactly the reported orphans", async () => {
    const big = media("big.png", "x".repeat(1000));
    for (const [releaseId, title, files] of [
      ["r1", "v1", [big]],
      ["r2", "v2", []],
      ["r3", "v3", []]
    ] as const) {
      await new Publisher(new FixtureSource({ pages: [item("a", title)] }, [...files]), store, { retentionCount: 2 })
        .publish("production", releaseId);
    }
    // r1 is out of retention, so its pages object and big.png are orphans
    const publisher = new Publisher(new FixtureSource(), store, { retentionCount: 2 });

    const dry = await publisher.garbageCollect({ dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.deletedObjects).toBe(1);
    expect(dry.deletedMedia).toBe(1);
    expect(dry.freedBytes).toBeGreaterThan(1000);
    expect(await store.listMedia()).toHaveLength(1);
    expect(await store.listObjects()).toHaveLength(3);

    const real = await publisher.garbageCollect();
    expect(real.dryRun).toBe(false);
    expect(real.report.orphans.files).toEqual(dry.report.orphans.files);
    expect(await store.listMedia()).toHaveLength(0);
    expect(await store.listObjects()).toHaveLength(2);

    const again = await publisher.garbageCollect({ dryRun: true });
    expect(again.report.orphans.files).toEqual([]);
  });

  it("retention never deletes a release that a channel still points to", async () => {
    const publish = (channel: string, releaseId: string) =>
      new Publisher(new FixtureSource({ pages: [item("a", releaseId)] }, []), store, { retentionCount: 2 })
        .publish(channel, releaseId);

    await publish("stable", "r1");
    await publish("production", "r2");
    await publish("production", "r3");
    await publish("production", "r4");

    const releases = await store.listReleases();
    expect(releases).toContain("r1"); // pinned by "stable", even though it's the oldest
    expect(releases).not.toContain("r2");
    expect(releases).toContain("r3");
    expect(releases).toContain("r4");

    const report = await new Publisher(new FixtureSource(), store).analyzeStorage();
    expect(report.channels.stable).toEqual({ releaseId: "r1", retained: true });
  });
});
