import { describe, it, expect } from "vitest";
import {
  createItemEditor,
  unpublishedValue,
  CollectionItem,
  ContentType,
  EditValue,
  ItemEditError,
  ItemSnapshot,
  SourceEditor,
  SourceFieldRef,
  SourceMap
} from "../server/src/index.js";

type Row = Record<string, unknown> & { id: string };

// A small CMS: blocks with features (one-to-many, sorted) and a flat collection of systems. The
// snapshot maps them like a preview's release and source map would; the editor writes back.
function cms() {
  const records: Record<string, Row[]> = {
    blocks: [{ id: "b1" }],
    features: [
      { id: "f1", block: "b1", title: "One", status: "published", sort: 10 },
      { id: "f2", block: "b1", title: "Two", status: "published", sort: 11 },
      { id: "f3", block: "b1", title: "Three", status: "published", sort: 12 }
    ],
    systems: [
      { id: "s1", name: "Alpha", sort: 2 },
      { id: "s2", name: "Beta", sort: 1 }
    ]
  };
  let next = 100;
  const deleted: string[] = [];

  const types: ContentType[] = [
    {
      collection: "features",
      fields: [
        { field: "title", kind: "text", required: true },
        { field: "icon", kind: "string" },
        { field: "status", kind: "status", options: ["published", "draft", "archived"] },
        { field: "sort", kind: "sort" }
      ]
    },
    { collection: "systems", fields: [{ field: "name", kind: "text", required: true }, { field: "sort", kind: "sort" }] }
  ];

  const ref = (collection: string, id: string, field: string): SourceFieldRef => ({ collection, id, field });
  const snapshot = async (): Promise<ItemSnapshot> => {
    const published = records.features.filter((f) => f.status === "published").sort((a, b) => Number(a.sort) - Number(b.sort));
    const collections: Record<string, CollectionItem[]> = {
      // A block lists its features as references, like _blocks.items
      _blocks: [{ id: "block-1", key: "block-1", translations: {}, items: published.map((f) => ({ collection: "features", id: f.id })) }],
      features: published.map((f) => ({ id: f.id, key: f.id, status: f.status, sort: f.sort, translations: { en: { title: f.title } } })),
      systems: records.systems.map((s) => ({ id: s.id, key: s.id, sort: s.sort, translations: { en: { name: s.name } } }))
    };
    const map: SourceMap = {
      sources: { cms: {} },
      contentTypes: types,
      collections: {
        // The CDS block's list comes from the block record's features (children point back with `block`)
        _blocks: { items: { "block-1": { id: "b1", collection: "blocks", fields: { items: { ...ref("blocks", "b1", "features"), via: "block", editable: false } } } } },
        features: {
          source: { adapter: "cms", collection: "features" },
          items: Object.fromEntries(published.map((f) => [f.id, { id: f.id, collection: "features", fields: { status: ref("features", f.id, "status"), sort: ref("features", f.id, "sort") } }]))
        },
        systems: { source: { adapter: "cms", collection: "systems" }, items: Object.fromEntries(records.systems.map((s) => [s.id, { id: s.id }])) }
      },
      media: {}
    };
    return { collections, map, locale: "en" };
  };

  const rowOf = (collection: string, id: string) => records[collection].find((r) => r.id === id);
  const editor: SourceEditor = {
    login: async () => ({ accessToken: "t" }),
    read: async (r) => (rowOf(r.collection, r.id)?.[r.field] ?? null) as EditValue,
    async write(edit) {
      const row = rowOf(edit.ref.collection, edit.ref.id);
      if (!row) return { status: "rejected", message: "no such record" };
      const current = (row[edit.ref.field] ?? null) as EditValue;
      if (current !== edit.basedOn) return { status: "conflict", current };
      row[edit.ref.field] = edit.value;
      return { status: "saved", value: edit.value };
    },
    async create(collection, data) {
      const id = `n${next++}`;
      records[collection].push({ id, ...data } as Row);
      return id;
    },
    async delete(collection, id) {
      records[collection] = records[collection].filter((r) => r.id !== id);
      deleted.push(`${collection}/${id}`);
    }
  };
  const session = { accessToken: "t" };
  return { records, deleted, editor, snapshot, session, types };
}

const order = (rows: Row[], filter: (r: Row) => boolean = () => true) =>
  rows.filter(filter).sort((a, b) => Number(a.sort) - Number(b.sort)).map((r) => r.title ?? r.name);

describe("item editor", () => {
  it("describes a collection by its content type", async () => {
    const { editor, snapshot } = cms();
    const items = createItemEditor({ editor, snapshot });
    expect((await items.describe("features"))?.fields.map((f) => f.field)).toEqual(["title", "icon", "status", "sort"]);
    expect(await items.describe("unknown")).toBeNull();
  });

  it("finds the list an item is in: its parent's field, or its collection", async () => {
    const { editor, snapshot } = cms();
    const items = createItemEditor({ editor, snapshot });
    expect(await items.listOf("features", "f2")).toEqual({ list: { collection: "_blocks", id: "block-1", field: "items" }, items: ["f1", "f2", "f3"] });
    expect(await items.listOf("systems", "s1")).toEqual({ list: null, items: ["s2", "s1"] });
  });

  it("adds an item to a parent's list: linked to the parent's record, published, in its place", async () => {
    const { records, editor, snapshot, session } = cms();
    const items = createItemEditor({ editor, snapshot, createDefaults: () => ({ project: "p1" }) });
    const { id } = await items.add({ collection: "features", values: { title: "New" }, list: { collection: "_blocks", id: "block-1", field: "items" }, after: "f1" }, session);
    expect(records.features.find((f) => f.id === id)).toMatchObject({ block: "b1", title: "New", status: "published", project: "p1" });
    expect(order(records.features)).toEqual(["One", "New", "Two", "Three"]);
    // The list keeps where its sort values were
    expect(records.features.map((f) => f.sort).sort()).toEqual([10, 11, 12, 13]);
  });

  it("adds at the top, and at the end of a whole collection", async () => {
    const { records, editor, snapshot, session } = cms();
    const items = createItemEditor({ editor, snapshot });
    await items.add({ collection: "features", values: { title: "First" }, list: { collection: "_blocks", id: "block-1", field: "items" }, after: null }, session);
    expect(order(records.features)).toEqual(["First", "One", "Two", "Three"]);
    await items.add({ collection: "systems", values: { name: "Gamma" } }, session);
    expect(order(records.systems)).toEqual(["Beta", "Alpha", "Gamma"]);
  });

  it("refuses a new item without its required fields, or with fields its type doesn't have", async () => {
    const { editor, snapshot, session } = cms();
    const items = createItemEditor({ editor, snapshot });
    await expect(items.add({ collection: "features", values: { icon: "x" } }, session)).rejects.toThrow(/needs title/);
    await expect(items.add({ collection: "features", values: { title: "x", colour: "red" } }, session)).rejects.toThrow(/no field colour/);
    await expect(items.add({ collection: "pages", values: {} }, session)).rejects.toBeInstanceOf(ItemEditError);
  });

  it("reorders a list by its sort field, and refuses a list that changed", async () => {
    const { records, editor, snapshot, session } = cms();
    const items = createItemEditor({ editor, snapshot });
    const list = { collection: "_blocks", id: "block-1", field: "items" };
    await items.reorder({ collection: "features", items: ["f3", "f1", "f2"], list }, session);
    expect(order(records.features)).toEqual(["Three", "One", "Two"]);
    await expect(items.reorder({ collection: "features", items: ["f1", "f2"], list }, session)).rejects.toThrow(/changed/);
    await items.reorder({ collection: "systems", items: ["s1", "s2"] }, session);
    expect(order(records.systems)).toEqual(["Alpha", "Beta"]);
  });

  it("unpublishes an item with a status, and deletes one without", async () => {
    const { records, deleted, editor, snapshot, session } = cms();
    const items = createItemEditor({ editor, snapshot });
    expect(await items.remove({ collection: "features", id: "f2" }, session)).toEqual({ result: "unpublished" });
    expect(records.features.find((f) => f.id === "f2")?.status).toBe("draft");
    expect((await items.listOf("features", "f1")).items).toEqual(["f1", "f3"]);
    expect(await items.remove({ collection: "systems", id: "s1" }, session)).toEqual({ result: "deleted" });
    expect(deleted).toEqual(["systems/s1"]);
  });

  it("reports a write against a source that changed meanwhile as a conflict", async () => {
    const { records, editor, snapshot, session } = cms();
    const stale = await snapshot();
    records.features[0].status = "archived";
    const items = createItemEditor({ editor, snapshot: async () => stale });
    await expect(items.remove({ collection: "features", id: "f1" }, session)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("picks the status value that takes an item out of the release", () => {
    expect(unpublishedValue({ field: "status", kind: "status", options: ["published", "archived"] })).toBe("archived");
    expect(unpublishedValue({ field: "status", kind: "status", options: ["published", "hidden"] })).toBe("hidden");
    expect(unpublishedValue({ field: "status", kind: "status" })).toBe("draft");
  });
});
