import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  createPublishSdk,
  FilesystemStore,
  CollectionItem,
  ContentSource,
  ContentType,
  EditValue,
  MediaRenderer,
  SourceEditor,
  SourceMap,
  SourceMedia
} from "../server/src/index.js";
import { CDSClient, MemoryStorage } from "../client/src/index.js";
import { downloaderFor } from "./helpers.js";

type Row = Record<string, unknown> & { id: string };

// A small CMS: records per collection and files. The source maps them like content types do
// (texts into translations.en, files to media paths); the editor writes them back.
function cms() {
  const records: Record<string, Row[]> = {
    rooms: [{ id: "1", slug: "suite", name: "Suite", name_de: "Suite (DE)", project: "a", cover: null }]
  };
  const files = new Map<string, { content: Buffer; mimeType: string; title?: string }>();
  let nextId = 2;

  const source = (): ContentSource => {
    const items: CollectionItem[] = records.rooms.map((r) => ({
      id: `room-${r.id}`,
      key: String(r.slug),
      ...(r.cover ? { cover: `cms/${r.cover}.png`, media: [`cms/${r.cover}.png`] } : { cover: null }),
      translations: { en: { name: r.name }, ...(r.name_de ? { de: { name: r.name_de } } : {}) }
    }));
    const map: SourceMap = {
      sources: { cms: {} },
      collections: {
        rooms: {
          items: Object.fromEntries(records.rooms.map((r) => [
            `room-${r.id}`,
            {
              id: r.id,
              collection: "rooms",
              fields: {
                "translations.en.name": { collection: "rooms", id: r.id, field: "name" },
                "translations.de.name": { collection: "rooms", id: r.id, field: "name_de" },
                slug: { collection: "rooms", id: r.id, field: "slug" }
              }
            }
          ]))
        }
      },
      media: {}
    };
    const media: SourceMedia[] = [...files].map(([id, f]) => ({ virtualPath: `cms/${id}.png`, content: f.content, mimeType: f.mimeType }));
    return {
      getCollections: async () => ({ rooms: items }),
      getMedia: async () => media,
      getSourceMap: async () => map,
      getSourceLocale: async () => "en"
    };
  };

  const row = (collection: string, id: string) => records[collection]?.find((r) => r.id === id);
  const editor: Required<Pick<SourceEditor, "read" | "write" | "create" | "upload">> & SourceEditor = {
    login: async () => ({ accessToken: "t" }),
    read: async (ref) => (row(ref.collection, ref.id)?.[ref.field] ?? null) as EditValue,
    write: async (edit) => {
      const r = row(edit.ref.collection, edit.ref.id)!;
      const current = (r[edit.ref.field] ?? null) as EditValue;
      if (String(current ?? "") !== String(edit.basedOn ?? "")) return { status: "conflict", current };
      r[edit.ref.field] = edit.value;
      return { status: "saved", value: edit.value };
    },
    create: async (collection, data) => {
      const id = String(nextId++);
      records[collection]!.push({ ...data, id });
      return id;
    },
    upload: async (file) => {
      const id = `f${nextId++}`;
      files.set(id, { content: file.content, mimeType: file.mimeType, ...(file.title ? { title: file.title } : {}) });
      return id;
    }
  };
  return { records, files, source, editor };
}

const rooms: ContentType = {
  collection: "rooms",
  fields: [
    { field: "slug", kind: "slug", required: true },
    { field: "name", kind: "text" },
    { field: "cover", kind: "file" }
  ]
};

describe("Publish SDK (P19)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "cds-sdk-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const sdkFor = (system: ReturnType<typeof cms>, renderer?: MediaRenderer) =>
    createPublishSdk({
      source: system.source,
      editor: system.editor,
      session: { accessToken: "static-token" },
      store: new FilesystemStore(dir),
      contentTypes: [rooms],
      createDefaults: () => ({ project: "a" }),
      targets: [
        {
          id: "screens",
          scope: ["rooms"],
          collections: { rooms: { presets: ["card"] } },
          media: { breakpoints: { all: 0 }, presets: { card: { fit: "fit", widths: { all: 300 }, formats: ["webp"] } } }
        }
      ],
      ...(renderer ? { renderer } : {})
    });

  const read = async () => {
    const client = new CDSClient({ storage: new MemoryStorage(), downloader: downloaderFor(dir) });
    await client.initialize();
    await client.sync("production");
    return client;
  };

  it("writes a text by key to its source field, and the next release has it", async () => {
    const system = cms();
    const sdk = sdkFor(system);
    expect((await sdk.use("rooms").get("suite"))?.translations.en.name).toBe("Suite");

    const result = await sdk.use("rooms").set("suite", { name: "Grand Suite" });
    expect(result).toMatchObject({ status: "saved", id: "1", fields: { name: { status: "saved", value: "Grand Suite" } } });
    expect(system.records.rooms[0]!.name).toBe("Grand Suite");
    // the SDK reads again after writing
    expect((await sdk.use("rooms").get("suite"))?.translations.en.name).toBe("Grand Suite");

    await sdk.publish("production", { releaseId: "r1" });
    expect((await read()).use("rooms").get("suite")?.translations.en.name).toBe("Grand Suite");
  });

  it("writes a text in another locale to that locale's source field", async () => {
    const system = cms();
    const sdk = sdkFor(system);
    const result = await sdk.useLocale("de").use("rooms").set("suite", { name: "Grosse Suite" });
    expect(result).toMatchObject({ status: "saved", fields: { name: { status: "saved", value: "Grosse Suite" } } });
    expect(system.records.rooms[0]).toMatchObject({ name: "Suite", name_de: "Grosse Suite" });
    // creating starts in the source locale
    expect((await sdk.useLocale("de").use("rooms").set("loft", { name: "Dachzimmer" })).status).toBe("rejected");
  });

  it("reports a conflict when the source changed after the SDK read it", async () => {
    const system = cms();
    const sdk = sdkFor(system);
    await sdk.use("rooms").get("suite");
    system.records.rooms[0]!.name = "Changed in the CMS";
    const result = await sdk.use("rooms").set("suite", { name: "Mine" });
    expect(result.status).toBe("conflict");
    expect(result.fields.name).toEqual({ status: "conflict", current: "Changed in the CMS" });
    expect(system.records.rooms[0]!.name).toBe("Changed in the CMS");
  });

  it("creates a missing item with its key and the defaults", async () => {
    const system = cms();
    const result = await sdkFor(system).use("rooms").set("loft", { name: "Loft" });
    expect(result.status).toBe("created");
    expect(system.records.rooms[1]).toEqual({ id: result.id, slug: "loft", name: "Loft", project: "a" });
  });

  it("rejects fields without a source, and creating without a content type", async () => {
    const system = cms();
    const sdk = sdkFor(system);
    expect((await sdk.use("rooms").set("suite", { price: 100 })).fields.price?.status).toBe("rejected");
    const other = createPublishSdk({ source: system.source, editor: system.editor, session: { accessToken: "t" }, store: new FilesystemStore(dir) });
    expect((await other.use("rooms").set("new", { name: "x" })).status).toBe("rejected");
  });

  it("uploads an original, sets it in a file field, and renders its sizes only at release", async () => {
    const system = cms();
    let renders = 0;
    const renderer: MediaRenderer = {
      render: async (_source, request) => {
        renders++;
        return { content: Buffer.from(`${request.width}w`), width: request.width, height: 200 };
      }
    };
    const sdk = sdkFor(system, renderer);
    const { id } = await sdk.media.add({ content: Buffer.from("png-bytes"), filename: "suite.png", mimeType: "image/png", title: "The suite" });
    expect(renders).toBe(0);
    expect((await sdk.use("rooms").set("suite", { cover: id })).status).toBe("saved");
    expect(system.records.rooms[0]!.cover).toBe(id);

    const { manifest } = await sdk.publish("production", { releaseId: "r1" });
    expect(renders).toBe(1);
    expect(Object.keys(manifest.media).sort()).toEqual([`cms/${id}.png`, `cms/${id}.png@card-300w.webp`]);
    const client = await read();
    expect(client.use("rooms").get("suite")?.cover).toBe(`cms/${id}.png`);
    expect(client.getMediaInfo(`cms/${id}.png`)?.variants?.[0]).toMatchObject({ path: `cms/${id}.png@card-300w.webp`, width: 300 });
  });
});
