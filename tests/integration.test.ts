import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import os from "os";

// Import from our compiled packages (via pnpm workspace links)
import { 
  Publisher, 
  FixtureSource, 
  FilesystemStore,
  deterministicStringify,
  sha256
} from "../server/src/index.js";

import { 
  CDSClient, 
  FilesystemStorage,
  RemoteDownloader,
  ChannelManifest,
  ReleaseManifest
} from "../client/src/index.js";

// A RemoteDownloader implementation that reads directly from the Server's FilesystemStore.
// It tracks the number of fetches to let us assert CAS reuse of unchanged objects.
class LocalStoreDownloader implements RemoteDownloader {
  private baseDir: string;
  public fetchCounts = {
    channelManifest: 0,
    releaseManifest: 0,
    object: 0,
    media: 0
  };

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  async fetchChannelManifest(channel: string, currentEtag?: string): Promise<{ manifest: ChannelManifest; etag?: string; notModified?: boolean }> {
    this.fetchCounts.channelManifest++;
    const safeChannel = channel.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filePath = path.join(this.baseDir, "channels", safeChannel, "manifest.json");
    
    if (!existsSync(filePath)) {
      throw new Error(`Remote channel manifest not found for: ${channel}`);
    }

    const content = await fs.readFile(filePath, "utf-8");
    const manifest: ChannelManifest = JSON.parse(content);

    // ETag is simply the releaseId in our system
    if (currentEtag && currentEtag === manifest.releaseId) {
      return { manifest, etag: manifest.releaseId, notModified: true };
    }

    return { manifest, etag: manifest.releaseId, notModified: false };
  }

  async fetchReleaseManifest(releaseId: string): Promise<ReleaseManifest> {
    this.fetchCounts.releaseManifest++;
    const safeId = releaseId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filePath = path.join(this.baseDir, "releases", `${safeId}.json`);
    
    if (!existsSync(filePath)) {
      throw new Error(`Remote release manifest not found: ${releaseId}`);
    }

    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content);
  }

  async fetchObject(hash: string): Promise<string> {
    this.fetchCounts.object++;
    const filePath = path.join(this.baseDir, "objects", `${hash}.json`);
    
    if (!existsSync(filePath)) {
      throw new Error(`Remote object not found: ${hash}`);
    }

    return await fs.readFile(filePath, "utf-8");
  }

  async fetchMedia(hash: string, ext: string): Promise<Buffer> {
    this.fetchCounts.media++;
    const extension = ext.startsWith(".") ? ext : `.${ext}`;
    const filePath = path.join(this.baseDir, "media", `${hash}${extension}`);
    
    if (!existsSync(filePath)) {
      throw new Error(`Remote media asset not found: ${hash}`);
    }

    return await fs.readFile(filePath);
  }
}

describe("CDS Integration Tests (Milestone 1)", () => {
  let tempServerDir: string;
  let tempClientDir: string;

  beforeEach(async () => {
    // Create actual temporary directories for end-to-end local testing
    tempServerDir = await fs.mkdtemp(path.join(os.tmpdir(), "cds-server-test-"));
    tempClientDir = await fs.mkdtemp(path.join(os.tmpdir(), "cds-client-test-"));
  });

  afterEach(async () => {
    // Clean up temporary directories
    await fs.rm(tempServerDir, { recursive: true, force: true });
    await fs.rm(tempClientDir, { recursive: true, force: true });
  });

  it("should successfully run the complete CDS publishing, synchronization, CAS object reuse, retention, and garbage collection lifecycle", async () => {
    // -------------------------------------------------------------
    // STEP 1: PUBLISH RELEASE 1
    // -------------------------------------------------------------
    const initialCollections = {
      categories: [
        {
          id: "cat_books",
          key: "books",
          translations: {
            en: { name: "Books" },
            de: { name: "Bücher" }
          }
        }
      ],
      books: [
        {
          id: "book_1",
          key: "the-hobbit",
          translations: {
            en: { title: "The Hobbit" },
            de: { title: "Der Hobbit" }
          },
          references: [{ collection: "categories", id: "cat_books" }],
          media: ["covers/hobbit.jpg"]
        }
      ]
    };

    const initialMedia = [
      {
        virtualPath: "covers/hobbit.jpg",
        content: Buffer.from("fake-jpg-bytes-for-hobbit-cover"),
        mimeType: "image/jpeg"
      }
    ];

    const source = new FixtureSource(initialCollections, initialMedia);
    const serverStore = new FilesystemStore(tempServerDir);
    const publisher = new Publisher(source, serverStore, { retentionCount: 2 });

    // Publish release-1 on "production" channel
    const { manifest: rel1Manifest } = await publisher.publish("production", "release-1");

    expect(rel1Manifest.releaseId).toBe("release-1");
    expect(rel1Manifest.collections.categories).toBeDefined();
    expect(rel1Manifest.collections.books).toBeDefined();
    expect(rel1Manifest.media["covers/hobbit.jpg"]).toBeDefined();

    // Verify storage layout of server
    expect(existsSync(path.join(tempServerDir, "channels", "production", "manifest.json"))).toBe(true);
    expect(existsSync(path.join(tempServerDir, "releases", "release-1.json"))).toBe(true);
    expect(existsSync(path.join(tempServerDir, "objects", `${rel1Manifest.collections.categories.hash}.json`))).toBe(true);
    expect(existsSync(path.join(tempServerDir, "objects", `${rel1Manifest.collections.books.hash}.json`))).toBe(true);
    expect(existsSync(path.join(tempServerDir, "media", `${rel1Manifest.media["covers/hobbit.jpg"].hash}.jpg`))).toBe(true);

    // Collection size matches the stored object's byte size
    const booksStat = await fs.stat(path.join(tempServerDir, "objects", `${rel1Manifest.collections.books.hash}.json`));
    expect(rel1Manifest.collections.books.size).toBe(booksStat.size);

    // -------------------------------------------------------------
    // STEP 2: CLIENT INITIALIZATION & INITIAL SYNC
    // -------------------------------------------------------------
    const downloader = new LocalStoreDownloader(tempServerDir);
    const clientStorage = new FilesystemStorage(tempClientDir);
    const client = new CDSClient({
      storage: clientStorage,
      downloader,
      retentionCount: 2
    });

    await client.initialize();
    expect(client.getActiveRelease()).toBeNull();

    // Perform initial sync
    const syncRes1 = await client.sync("production");
    expect(syncRes1.success).toBe(true);
    expect(syncRes1.updated).toBe(true);
    expect(syncRes1.releaseId).toBe("release-1");

    // Verify active release on client
    const activeRel = client.getActiveRelease();
    expect(activeRel).not.toBeNull();
    expect(activeRel?.releaseId).toBe("release-1");

    // Query active release data from client cache / APIs
    const collectionsList = client.getCollectionsList();
    expect(collectionsList).toContain("categories");
    expect(collectionsList).toContain("books");

    const locales = client.getLocales();
    expect(locales).toContain("en");
    expect(locales).toContain("de");

    const books = await client.getCollection("books");
    expect(books).toHaveLength(1);
    expect(books[0].key).toBe("the-hobbit");

    // Test lookup by ID & key
    const bookById = await client.getItemById("books", "book_1");
    const bookByKey = await client.getItemByKey("books", "the-hobbit");
    expect(bookById).toEqual(books[0]);
    expect(bookByKey).toEqual(books[0]);

    // Test reference resolution
    const resolvedRefs = await client.resolveReferences(books[0]);
    expect(resolvedRefs).toHaveLength(1);
    expect(resolvedRefs[0].id).toBe("cat_books");
    expect(resolvedRefs[0].key).toBe("books");

    // Test media access
    const mediaContent = await client.getMediaContent("covers/hobbit.jpg");
    expect(mediaContent?.toString()).toBe("fake-jpg-bytes-for-hobbit-cover");

    // Verify downloader fetch counts for first release
    expect(downloader.fetchCounts.channelManifest).toBe(1);
    expect(downloader.fetchCounts.releaseManifest).toBe(1);
    expect(downloader.fetchCounts.object).toBe(2); // "categories" and "books"
    expect(downloader.fetchCounts.media).toBe(1); // "hobbit.jpg"

    // -------------------------------------------------------------
    // STEP 3: PUBLISH RELEASE 2 (DEMONSTRATING CAS REUSE)
    // -------------------------------------------------------------
    // Update only the books collection (add a new book), but categories and media are completely UNCHANGED!
    const secondCollections = {
      categories: [
        {
          id: "cat_books",
          key: "books",
          translations: {
            en: { name: "Books" },
            de: { name: "Bücher" }
          }
        }
      ],
      books: [
        {
          id: "book_1",
          key: "the-hobbit",
          translations: {
            en: { title: "The Hobbit" },
            de: { title: "Der Hobbit" }
          },
          references: [{ collection: "categories", id: "cat_books" }],
          media: ["covers/hobbit.jpg"]
        },
        {
          id: "book_2",
          key: "fellowship-of-the-ring",
          translations: {
            en: { title: "The Fellowship of the Ring" },
            de: { title: "Die Gefährten" }
          },
          references: [{ collection: "categories", id: "cat_books" }],
          media: ["covers/hobbit.jpg"] // Reuses the hobbit cover for simplicity
        }
      ]
    };

    // Instantiate a new source with updated data
    const source2 = new FixtureSource(secondCollections, initialMedia);
    const publisher2 = new Publisher(source2, serverStore, { retentionCount: 2 });

    const { manifest: rel2Manifest } = await publisher2.publish("production", "release-2");
    expect(rel2Manifest.releaseId).toBe("release-2");

    // Ensure the categories collection SHA-256 hash is IDENTICAL to release-1
    expect(rel2Manifest.collections.categories.hash).toBe(rel1Manifest.collections.categories.hash);
    // But books collection SHA-256 hash has CHANGED
    expect(rel2Manifest.collections.books.hash).not.toBe(rel1Manifest.collections.books.hash);

    // -------------------------------------------------------------
    // STEP 4: CLIENT SYNC RELEASE 2 (CONFIRM ONLY MISSING OBJECTS FETCHED)
    // -------------------------------------------------------------
    // Reset downloader count trackers
    downloader.fetchCounts.object = 0;
    downloader.fetchCounts.media = 0;

    const syncRes2 = await client.sync("production");
    expect(syncRes2.success).toBe(true);
    expect(syncRes2.updated).toBe(true);
    expect(syncRes2.releaseId).toBe("release-2");

    // VERIFY CAS CACHE SAVINGS:
    // Client should have fetched only 1 object (the modified "books" collection)
    // and exactly 0 media files (since hobbit.jpg was already in local storage!)
    expect(downloader.fetchCounts.object).toBe(1);
    expect(downloader.fetchCounts.media).toBe(0);

    // Double check that we can read both books now
    const booksAfterUpdate = await client.getCollection("books");
    expect(booksAfterUpdate).toHaveLength(2);
    expect(booksAfterUpdate[1].key).toBe("fellowship-of-the-ring");

    // -------------------------------------------------------------
    // STEP 5: RETENTION POLICY & SAFE GARBAGE COLLECTION
    // -------------------------------------------------------------
    // Publish a third release so that release-1 exceeds the server's retention policy (retentionCount = 2)
    const thirdCollections = {
      categories: [
        {
          id: "cat_books",
          key: "books",
          translations: { en: { name: "Books" }, de: { name: "Bücher" } }
        }
      ],
      books: [
        {
          // We completely delete "book_1" (The Hobbit), so its unique media covers/hobbit.jpg is no longer referenced anywhere in release-3!
          id: "book_2",
          key: "fellowship-of-the-ring",
          translations: { en: { title: "The Fellowship" }, de: { title: "Die Gefährten" } },
          references: [{ collection: "categories", id: "cat_books" }]
        }
      ]
    };

    // No media covers/hobbit.jpg in this source
    const source3 = new FixtureSource(thirdCollections, []);
    const publisher3 = new Publisher(source3, serverStore, { retentionCount: 2 });

    const { manifest: rel3Manifest } = await publisher3.publish("production", "release-3");
    expect(rel3Manifest.releaseId).toBe("release-3");

    // Since retentionCount = 2, and we have published release-1, release-2, and release-3:
    // release-1 should be deleted from server's releases directory!
    const activeReleases = await serverStore.listReleases();
    expect(activeReleases).not.toContain("release-1");
    expect(activeReleases).toContain("release-2");
    expect(activeReleases).toContain("release-3");

    // Run Garbage Collection on server
    // Since release-1 is gone, any object/media solely referenced by release-1 (and not by release-2 or 3) should be garbage collected!
    // In this case, "release-2" references books (re2 hash), categories, and "covers/hobbit.jpg" media.
    // "release-3" references books (re3 hash) and categories.
    // So categories, books (re2), books (re3), and covers/hobbit.jpg are all still referenced!
    // Let's run GC first: the books collection object unique to release-1 should be deleted (since release-1 is out of retention)
    const gc1 = await publisher3.garbageCollect();
    expect(gc1.deletedObjects).toBe(1);
    expect(gc1.deletedMedia).toBe(0);

    // Now, publish release-4 to push release-2 out of retention.
    // After this, only release-3 and release-4 are retained. Neither references "covers/hobbit.jpg" or the release-1/release-2 book objects!
    const fourthCollections = {
      categories: [],
      books: []
    };
    const source4 = new FixtureSource(fourthCollections, []);
    const publisher4 = new Publisher(source4, serverStore, { retentionCount: 2 });

    const { manifest: rel4Manifest } = await publisher4.publish("production", "release-4");
    expect(rel4Manifest.releaseId).toBe("release-4");

    const retainedAfter4 = await serverStore.listReleases();
    expect(retainedAfter4).not.toContain("release-1");
    expect(retainedAfter4).not.toContain("release-2");
    expect(retainedAfter4).toContain("release-3");
    expect(retainedAfter4).toContain("release-4");

    // Now run Garbage Collection.
    // Objects/media only referenced by release-1 or release-2 (like covers/hobbit.jpg, categories-hash, and book hashes from rel 1 and 2)
    // are now completely unreachable and should be garbage collected!
    const gc2 = await publisher4.garbageCollect();
    expect(gc2.deletedObjects).toBeGreaterThan(0);
    expect(gc2.deletedMedia).toBe(1); // covers/hobbit.jpg is successfully garbage collected!

    // Verify file deletion on server disk
    const mediaFiles = await serverStore.listMedia();
    expect(mediaFiles).toHaveLength(0); // covers/hobbit.jpg is gone!
  });

  it("should accept unknown additional fields in v1 manifests and collections (forward compatibility)", async () => {
    const serverStore = new FilesystemStore(tempServerDir);
    const publisher = new Publisher(new FixtureSource(), serverStore);
    const { manifest, artifacts } = await publisher.publish("production", "release-1");
    expect(artifacts).toEqual({});

    // Simulate a newer publisher: add unknown fields at every level of the published files.
    // The collection envelope is content-addressed, so rewrite it under its new hash.
    const objectPath = (hash: string) => path.join(tempServerDir, "objects", `${hash}.json`);
    const categories = JSON.parse(await fs.readFile(objectPath(manifest.collections.categories.hash), "utf-8"));
    categories.futureEnvelopeField = { anything: true };
    const serialized = deterministicStringify(categories);
    const newHash = sha256(serialized);
    await fs.writeFile(objectPath(newHash), serialized, "utf-8");

    const extendedRelease = {
      ...manifest,
      futureReleaseField: "x",
      collections: {
        ...manifest.collections,
        categories: { hash: newHash, itemCount: categories.items.length, size: Buffer.byteLength(serialized), futureMetaField: 1 }
      },
      media: Object.fromEntries(
        Object.entries(manifest.media).map(([p, m]) => [p, { ...m, futureMediaField: [1, 2] }])
      )
    };
    await fs.writeFile(path.join(tempServerDir, "releases", "release-1.json"), JSON.stringify(extendedRelease), "utf-8");

    const channelPath = path.join(tempServerDir, "channels", "production", "manifest.json");
    const channel = JSON.parse(await fs.readFile(channelPath, "utf-8"));
    await fs.writeFile(channelPath, JSON.stringify({ ...channel, futureChannelField: true }), "utf-8");

    const client = new CDSClient({
      storage: new FilesystemStorage(tempClientDir),
      downloader: new LocalStoreDownloader(tempServerDir)
    });
    const result = await client.sync("production");

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.releaseId).toBe("release-1");
    expect(await client.getCollection("categories")).toHaveLength(2);
  });
});
