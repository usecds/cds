import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { Publisher, FilesystemStore, ContentSource, CollectionItem, ContentType, contentTypeTarget, PublishRequirementsError } from "../server/src/index.js";
import { mapContentTypes, contentTypeCollections } from "../directus/src/content-types.js";
import type { DirectusMapContext } from "../directus/src/source.js";

// The integrations bundle's declaration, as the site converts it
const types: ContentType[] = [
  {
    collection: "integrations",
    fields: [
      { field: "status", kind: "status" },
      { field: "name", kind: "text", required: true },
      { field: "slug", kind: "slug" },
      { field: "description", kind: "richText" },
      { field: "lifecycle", kind: "select", options: ["Live", "Planned"] },
      { field: "logo", kind: "file" },
      { field: "category", kind: "reference", related: "integration_categories" },
      { field: "interfaces", kind: "references", related: "integration_interfaces", via: "integration" }
    ]
  },
  { collection: "integration_categories", fields: [{ field: "name", kind: "text" }, { field: "in_diagram", kind: "boolean" }] },
  {
    collection: "integration_interfaces",
    fields: [
      { field: "sort", kind: "sort" },
      { field: "integration", kind: "reference", related: "integrations" },
      { field: "name", kind: "text", required: true },
      { field: "transport", kind: "select", options: ["rest", "tcp"] }
    ]
  }
];

const ctx: DirectusMapContext = {
  locale: "en",
  media: (id) => (id ? `cms/${id}.png` : null),
  file: () => null,
  source: (collection, id, field, options = {}) => ({ collection, id: String(id), field, ...options }),
  log: () => undefined
};

const records = {
  integrations: [{
    id: "i1", status: "published", name: "Mews", slug: "mews", description: "<p>PMS</p>", lifecycle: "Live", logo: "f1",
    category: "c1",
    interfaces: [{ id: "x2", sort: 2, integration: "i1", name: "Webhooks", transport: "rest" }, { id: "x1", sort: 1, integration: "i1", name: "API", transport: "rest" }]
  }],
  integration_categories: [{ id: "c1", name: "PMS", in_diagram: true }]
};

describe("Content types", () => {
  it("say what to fetch: top-level types with their children expanded", () => {
    expect(contentTypeCollections(types)).toEqual({
      integrations: { fields: "*,interfaces.*" },
      integration_categories: { fields: "*" }
    });
  });

  it("map records generically: texts with sources, values, files, references, children as their own collection", () => {
    const out = mapContentTypes(types, records, ctx);
    const [mews] = out.integrations;
    expect(mews).toMatchObject({
      id: "i1",
      key: "mews",
      status: "published",
      lifecycle: "Live",
      logo: "cms/f1.png",
      category: "c1",
      interfaces: ["x1", "x2"],
      translations: { en: { name: "Mews", description: "<p>PMS</p>" } },
      $origin: { collection: "integrations", id: "i1" }
    });
    expect(mews.$sources!["translations.en.description"]).toEqual({ collection: "integrations", id: "i1", field: "description", format: "html" });
    expect(mews.$sources!.lifecycle).toEqual({ collection: "integrations", id: "i1", field: "lifecycle" });
    expect(out.integration_interfaces.map((i) => i.translations.en.name)).toEqual(["Webhooks", "API"]);
    expect(out.integration_interfaces[0].$sources!["translations.en.name"]).toMatchObject({ collection: "integration_interfaces", id: "x2" });
    expect(Object.keys(mapContentTypes(types, {}, ctx)).sort()).toEqual(["integration_categories", "integration_interfaces", "integrations"]);
  });

  it("imply publish checks: required fields and select values fail the publish", async () => {
    const target = contentTypeTarget(types);
    expect(target.scope).toEqual(["integrations", "integration_interfaces"]);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cds-content-types-"));
    try {
      const strip = (m: Record<string, any[]>) =>
        Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.map(({ $origin, $sources, ...item }) => item as CollectionItem)]));
      const source = (recs: Record<string, any[]>): ContentSource => ({ getCollections: async () => strip(mapContentTypes(types, recs, ctx)), getMedia: async () => [] });
      const good = { integration_categories: records.integration_categories, integrations: [{ ...records.integrations[0], logo: null }] };
      await new Publisher(source(good), new FilesystemStore(dir)).publish("production", "r1", { targets: [target] });

      const bad = { integrations: [{ ...good.integrations[0], name: "", interfaces: [{ id: "x9", name: "Socket", transport: "carrier-pigeon" }] }] };
      const error = await new Publisher(source(bad), new FilesystemStore(dir)).publish("production", "r2", { targets: [target] }).catch((e) => e);
      expect(error).toBeInstanceOf(PublishRequirementsError);
      expect(String(error.message)).toMatch(/name/);
      expect(String(error.message)).toMatch(/transport must be equal to one of the allowed values/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
