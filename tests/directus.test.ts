import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { Publisher, FilesystemStore } from "../server/src/index.js";
import { CDSClient, MemoryStorage, FilesystemDownloader } from "../client/src/index.js";
import { DirectusSource } from "../directus/src/source.js";
import { createDirectusCompat, DirectusCompatError } from "../directus/src/compat.js";
import { runQuery, project, parseFields } from "../directus/src/query.js";

const FILE_ID = "4f4b14fa-a43a-46d0-b7ad-90af5919bebb";
const UNUSED_FILE_ID = "11111111-2222-4333-8444-555555555555";

// A Directus instance as the source sees it: GET /items, /files and /assets
const directus: Record<string, any[]> = {
  pages: [
    { id: 2, status: "published", sort: 2, slug: "about", title: "About", hero: null, blocks: [{ id: 21, sort: 2 }, { id: 20, sort: 1 }] },
    { id: 1, status: "published", sort: 1, slug: "home", title: "Home", hero: FILE_ID, blocks: [] },
    { id: 3, status: "draft", sort: 3, slug: "draft", title: "Draft", hero: null, blocks: [] }
  ],
  languages: [{ code: "en-gb", name: "English" }, { code: "de-de", name: "Deutsch" }],
  menu_items: [
    { id: 1, label: "Home", to: { id: 1, slug: "home" }, menu: { id: 7, position: "header" } },
    { id: 2, label: "About", to: { id: 2, slug: "about" }, menu: { id: 8, position: "footer" } }
  ]
};
const files = [
  { id: FILE_ID, filename_download: "Hotel Lobby.jpg", title: "The lobby", description: null, type: "image/jpeg", width: 400, height: 200, focal_point_x: 100, focal_point_y: 50 },
  { id: UNUSED_FILE_ID, filename_download: "unused.png", title: null, type: "image/png", width: 1, height: 1 }
];

function mockDirectus() {
  const requests: string[] = [];
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    requests.push(`${init?.method ?? "GET"} ${input}`);
    const url = new URL(input);
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const items = /^\/items\/([^/]+)$/.exec(url.pathname);
    if (items) return items[1] in directus ? json(200, { data: directus[items[1]] }) : json(403, { errors: [{ message: "Forbidden" }] });
    if (url.pathname === "/files") return json(200, { data: files });
    if (url.pathname.startsWith("/assets/")) return new Response(Buffer.from("jpeg-bytes"), { status: 200, headers: { "content-type": "image/jpeg" } });
    return json(404, { errors: [{ message: "Not found" }] });
  });
  return requests;
}

describe("Directus query semantics", () => {
  const rows = [
    { id: 1, status: "published", sort: 2, name: "b", to: { id: 5, slug: "x" }, tags: [{ id: 1, name: "a" }] },
    { id: 2, status: "draft", sort: 1, name: "a", to: null, tags: [] },
    { id: 3, status: "published", sort: null, name: "c", to: { id: 6, slug: "y" }, tags: [{ id: 2, name: "b" }, { id: 3, name: "c" }] }
  ];

  it("filters by flat URL params, nested objects and related keys", () => {
    expect(runQuery(rows, { "filter[status][_eq]": "published" }).map((r) => r.id)).toEqual([1, 3]);
    expect(runQuery(rows, { filter: { to: { slug: { _in: ["y"] } } } }).map((r) => r.id)).toEqual([3]);
    expect(runQuery(rows, { "filter[to][_eq]": "5" }).map((r) => r.id)).toEqual([1]);
    expect(runQuery(rows, { "filter[to][_null]": "true" }).map((r) => r.id)).toEqual([2]);
    expect(runQuery(rows, { "filter[tags][name][_eq]": "c" }).map((r) => r.id)).toEqual([3]);
  });

  it("sorts with nulls last, keeps the stored order without a sort, and limits to 100 by default", () => {
    expect(runQuery(rows, { sort: "sort" }).map((r) => r.id)).toEqual([2, 1, 3]);
    expect(runQuery(rows, { sort: "-name" }).map((r) => r.id)).toEqual([3, 1, 2]);
    expect(runQuery(rows, {}).map((r) => r.id)).toEqual([1, 2, 3]);
    const many = Array.from({ length: 150 }, (_, i) => ({ id: i }));
    expect(runQuery(many, {})).toHaveLength(100);
    expect(runQuery(many, { limit: "-1" })).toHaveLength(150);
    expect(runQuery(many, { limit: 5, offset: 10 }).map((r) => r.id)).toEqual([10, 11, 12, 13, 14]);
  });

  it("sorts nested to-many arrays from deep[...][_sort]", () => {
    const [row] = runQuery([rows[2]], { fields: "*,tags.*", "deep[tags][_sort]": "-name" });
    expect(row.tags.map((t: any) => t.name)).toEqual(["c", "b"]);
    const [nested] = runQuery([rows[2]], { fields: "*,tags.*", deep: { tags: { _sort: ["name"] } } });
    expect(nested.tags.map((t: any) => t.name)).toEqual(["b", "c"]);
  });

  it("projects fields: * collapses relations to their key, named relations keep their fields", () => {
    expect(project(rows[0], parseFields("*"))).toEqual({ id: 1, status: "published", sort: 2, name: "b", to: 5, tags: [1] });
    expect(project(rows[0], parseFields("id,to.slug"))).toEqual({ id: 1, to: { slug: "x" } });
    expect(project(rows[0], parseFields(["name", "tags.*"]))).toEqual({ name: "b", tags: [{ id: 1, name: "a" }] });
  });
});

describe("DirectusSource and the compat API", () => {
  let dir: string;
  let requests: string[];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "cds-directus-"));
    requests = mockDirectus();
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const publishAndSync = async () => {
    const source = new DirectusSource({
      url: "http://directus.test",
      token: "read-token",
      defaultLocale: "en-gb",
      collections: { pages: { fields: "*,blocks.*", localized: ["title"] }, languages: {}, menu_items: { fields: "*,to.slug,to.id,menu.position" } }
    });
    const { manifest, artifacts } = await new Publisher(source, new FilesystemStore(dir)).publish("production", "r1");
    const client = new CDSClient({ storage: new MemoryStorage(), downloader: new FilesystemDownloader(dir) });
    await client.initialize();
    expect((await client.sync("production")).success).toBe(true);
    return { manifest, artifacts, client };
  };

  it("only sends GET requests and publishes the referenced files only", async () => {
    const { manifest, artifacts } = await publishAndSync();
    expect(requests.every((r) => r.startsWith("GET "))).toBe(true);
    expect(Object.keys(manifest.media)).toEqual([`directus/${FILE_ID}.jpg`]);
    expect(artifacts.sourceMap?.media[`directus/${FILE_ID}.jpg`]).toMatchObject({ adapter: "directus", id: FILE_ID });
  });

  it("describes files in _media: alt from title, focal point normalized, readable name", async () => {
    const { client } = await publishAndSync();
    const [media] = await client.getCollection("_media");
    expect(media).toMatchObject({
      id: `directus/${FILE_ID}.jpg`,
      name: "hotel-lobby",
      width: 400,
      height: 200,
      focalPoint: { x: 0.25, y: 0.25 },
      translations: { "en-gb": { alt: "The lobby", description: null } }
    });
  });

  it("answers Directus REST paths with the records as Directus returned them", async () => {
    const { client } = await publishAndSync();
    const api = createDirectusCompat(client);

    const published = await api.request("/items/pages?filter[status][_eq]=published&sort=sort&fields=id,slug,title");
    expect(published.data).toEqual([{ id: 1, slug: "home", title: "Home" }, { id: 2, slug: "about", title: "About" }]);

    const about = await api.request("/items/pages/2", { fields: "*,blocks.*", "deep[blocks][_sort]": "sort" });
    expect(about.data.blocks.map((b: any) => b.id)).toEqual([20, 21]);

    const footer = await api.items("menu_items", { "filter[menu][position][_eq]": "footer", fields: "label,to.slug" });
    expect(footer).toEqual([{ label: "About", to: { slug: "about" } }]);

    expect((await api.request("/items/languages/de-de")).data).toEqual({ code: "de-de", name: "Deutsch" });
    expect((await api.request(`/files/${FILE_ID}`, { fields: "id,title" })).data).toEqual({ id: FILE_ID, title: "The lobby" });
  });

  it("serves assets, applying the transform only when transform params are given", async () => {
    const { client } = await publishAndSync();
    const transform = vi.fn(async (original: { data: Buffer; type: string }, params: Record<string, string>) =>
      ({ data: Buffer.from(`${original.data}@${params.width}`), type: "image/webp" }));
    const api = createDirectusCompat(client, { transform });

    const original = await api.asset(FILE_ID);
    expect(original).toMatchObject({ type: "image/jpeg", filename: "Hotel Lobby.jpg" });
    expect(original.data.toString()).toBe("jpeg-bytes");
    expect(transform).not.toHaveBeenCalled();

    const resized = await api.asset(FILE_ID, { width: 200, format: "webp", unrelated: "x" });
    expect(resized.data.toString()).toBe("jpeg-bytes@200");
    expect(transform).toHaveBeenCalledWith(expect.anything(), { width: "200", format: "webp" });
  });

  it("answers like Directus for what the release doesn't have: 403 for collections, items, files", async () => {
    const { client } = await publishAndSync();
    const api = createDirectusCompat(client);
    for (const call of [() => api.items("unknown"), () => api.items("_media"), () => api.item("pages", 99), () => api.asset(UNUSED_FILE_ID)]) {
      await expect(call()).rejects.toMatchObject({ statusCode: 403 });
    }
    await expect(api.request("/users/me")).rejects.toBeInstanceOf(DirectusCompatError);
  });

  it("skips optional collections the token can't read, and fails on required ones", async () => {
    const config = { url: "http://directus.test", defaultLocale: "en-gb", collections: { pages: {}, secret: {} } };
    const optional = new DirectusSource({ ...config, optional: ["secret"] });
    expect(Object.keys(await optional.getCollections())).toEqual(["pages", "_media"]);
    await expect(new DirectusSource(config).getCollections()).rejects.toThrow(/secret: 403/);
  });
});
