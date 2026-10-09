import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { Publisher, FilesystemStore, CollectionItem, loadTargets, resolveTargets } from "../server/src/index.js";

const write = async (file: string, data: unknown) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data));
};

describe("Targets that extend other definitions", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "cds-extends-test-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("merges relative files and packages in first, then the target's own rules", async () => {
    // A package with an exports map, as @usecds/collections ships its definitions
    await write(path.join(dir, "node_modules/@acme/rules/package.json"), { name: "@acme/rules", exports: { "./posts": "./posts.json" } });
    await write(path.join(dir, "node_modules/@acme/rules/posts.json"), {
      id: "posts",
      recommendations: { posts: { localized: { type: "object", required: ["title"] } } }
    });
    await write(path.join(dir, "targets/shared.json"), {
      id: "shared",
      extends: ["@acme/rules/posts"],
      collections: { posts: { minItems: 1 } }
    });
    await write(path.join(dir, "targets/web.json"), {
      id: "web",
      extends: ["./shared.json"],
      collections: { posts: { minItems: 3, localized: { type: "object", required: ["intro"] } } }
    });

    const web = (await loadTargets(path.join(dir, "targets"))).find((t) => t.id === "web")!;
    expect(web.extends).toBeUndefined();
    // The stricter minimum wins; the schemas from both levels must pass
    expect(web.collections?.posts.minItems).toBe(3);
    expect(web.collections?.posts.localized).toEqual({ type: "object", required: ["intro"] });
    expect(web.recommendations?.posts.localized).toEqual({ type: "object", required: ["title"] });
  });

  it("reports the recommendations of an extended definition without failing the publish", async () => {
    // The definition @usecds/collections ships
    await fs.mkdir(path.join(dir, "rules"));
    await fs.copyFile(path.resolve("collections/posts.json"), path.join(dir, "rules/posts.json"));
    await write(path.join(dir, "targets/web.json"), { id: "web", extends: ["../rules/posts.json"] });
    const targets = await loadTargets(path.join(dir, "targets"));
    const posts: CollectionItem[] = [{ id: "p1", key: "hello", translations: { en: { title: "Hello" } } }];
    const result = await new Publisher(
      { getCollections: async () => ({ posts }), getMedia: async () => [] },
      new FilesystemStore(path.join(dir, "store"))
    ).publish("production", "r1", { sourceLocale: "en", targets });
    const issues = result.artifacts.content.issues.filter((i) => i.collection === "posts");
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.severity === "recommendation")).toBe(true);
  });

  it("rejects cycles, unknown packages and unresolved extends", async () => {
    await write(path.join(dir, "a/a.json"), { id: "a", extends: ["./b.json"] });
    await write(path.join(dir, "a/b.json"), { id: "b", extends: ["./a.json"] });
    await expect(loadTargets(path.join(dir, "a"))).rejects.toThrow(/Target extends itself/);

    await write(path.join(dir, "missing/web.json"), { id: "web", extends: ["@acme/nothing/here"] });
    await expect(loadTargets(path.join(dir, "missing"))).rejects.toThrow(/extends "@acme\/nothing\/here", which can't be found/);

    expect(() => resolveTargets([{ id: "web", extends: ["./x.json"] }])).toThrow(/extends is resolved when targets are loaded/);
  });
});
