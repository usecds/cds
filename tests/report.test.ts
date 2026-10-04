import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  Publisher,
  FilesystemStore,
  CollectionItem,
  ContentSource,
  PublishRequirementsError,
  createPublishReport,
  renderPublishReportHtml
} from "../server/src/index.js";

const sourceOf = (collections: Record<string, CollectionItem[]>): ContentSource => ({
  getCollections: async () => collections,
  getMedia: async () => []
});

describe("Publish report", () => {
  let storeDir: string;

  beforeEach(async () => {
    storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "cds-report-test-"));
  });

  afterEach(async () => {
    await fs.rm(storeDir, { recursive: true, force: true });
  });

  it("summarizes a successful publish", async () => {
    const pages: CollectionItem[] = [
      { id: "home", key: "home", translations: { en: { title: "Home", body: "Hi" }, de: { title: "Start" } } }
    ];
    const { manifest, artifacts } = await new Publisher(sourceOf({ pages }), new FilesystemStore(storeDir))
      .publish("production", "r1", { sourceLocale: "en" });

    const report = createPublishReport({ channel: "production", releaseId: "r1", artifacts, manifest });
    expect(report).toMatchObject({
      status: "published",
      summary: {
        requirements: 0,
        recommendations: 1,
        targets: { satisfied: 1, total: 1 },
        translations: { expected: 2, translated: 1, missing: 1 }
      },
      release: { collections: 1, items: 1, media: 0 }
    });
    expect(report.issues[0]).toMatchObject({ issue: "untranslated", locale: "de", field: "body" });
    expect(report).not.toHaveProperty("error");
  });

  it("reports a failed publish with its requirements first, and escapes content in HTML", async () => {
    const pages: CollectionItem[] = [
      { id: "<script>x</script>", key: "home", translations: { en: { title: "Home", body: "Hi" }, de: { title: "Start" } } }
    ];
    const target = { id: "default", locales: { minCompleteness: 1 } };
    const error = await new Publisher(sourceOf({ pages }), new FilesystemStore(storeDir))
      .publish("production", "r1", { sourceLocale: "en", targets: [target] })
      .catch((e) => e as PublishRequirementsError);

    const report = createPublishReport({ channel: "production", releaseId: "r1", artifacts: error.artifacts, error });
    expect(report.status).toBe("failed");
    expect(report.error).toMatch(/1 unmet target requirement/);
    expect(report).not.toHaveProperty("release");
    expect(report.issues.map((i) => i.severity)).toEqual(["requirement", "recommendation"]);

    const html = renderPublishReportHtml(report);
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain(">failed<");
  });
});
