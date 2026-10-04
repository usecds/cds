import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { render, RenderOptions, ImageFormat } from "./index.js";

// A planned or rendered variant; bytes and ms are set once it's rendered
export interface CachedVariant {
  name: string; // file name in the cache folder, e.g. "coast-banner-1152.7350c4c1.avif"
  key: string; // variant key (source hash + options)
  path: string; // virtual path of the source media
  options: RenderOptions;
  format: ImageFormat;
  width: number; // planned, then actual
  height?: number;
  bytes?: number;
  ms?: number;
  upscaled?: boolean;
  flattened?: boolean;
}

const INDEX_FILE = "variants.json";

/**
 * Variant cache in a folder: variants are registered when a page plans them and rendered on
 * request (ensure), or right away. Parallel requests for the same variant share one render.
 * With an index, rendered variants survive restarts: a variant whose file exists isn't rendered again.
 */
export class VariantCache {
  private variants = new Map<string, CachedVariant>();
  private inflight = new Map<string, Promise<CachedVariant>>();
  private saving: Promise<void> = Promise.resolve();

  private constructor(readonly dir: string, private readonly persist: boolean) {}

  /**
   * Opens (and creates) a cache folder. persist keeps an index (variants.json) in the folder,
   * so a later process knows the variants without re-planning them; leave it off for public output.
   */
  static async open(dir: string, options: { persist?: boolean } = {}): Promise<VariantCache> {
    const cache = new VariantCache(dir, options.persist ?? false);
    await fs.mkdir(dir, { recursive: true });
    if (cache.persist && existsSync(path.join(dir, INDEX_FILE))) {
      const saved: CachedVariant[] = JSON.parse(await fs.readFile(path.join(dir, INDEX_FILE), "utf-8"));
      // Only variants whose file still exists count as rendered
      for (const v of saved) {
        const rendered = existsSync(path.join(dir, v.name));
        cache.variants.set(v.name, rendered ? v : { ...v, bytes: undefined, ms: undefined });
      }
    }
    return cache;
  }

  /**
   * Registers a planned variant (no rendering). Returns the known entry if the name exists.
   */
  register(variant: Omit<CachedVariant, "bytes" | "ms" | "upscaled" | "flattened">): CachedVariant {
    const existing = this.variants.get(variant.name);
    if (existing) return existing;
    const entry: CachedVariant = { ...variant };
    this.variants.set(variant.name, entry);
    return entry;
  }

  get(name: string): CachedVariant | undefined {
    return this.variants.get(name);
  }

  isRendered(name: string): boolean {
    const v = this.variants.get(name);
    return v?.bytes !== undefined && existsSync(path.join(this.dir, name));
  }

  /**
   * Renders a registered variant unless it's already rendered. Parallel calls share one render.
   */
  async ensure(name: string, loadSource: (virtualPath: string) => Promise<Buffer | null>): Promise<CachedVariant> {
    const variant = this.variants.get(name);
    if (!variant) throw new Error(`Unknown variant ${name}`);
    if (this.isRendered(name)) return variant;

    let pending = this.inflight.get(name);
    if (!pending) {
      pending = (async () => {
        const source = await loadSource(variant.path);
        if (!source) throw new Error(`Source ${variant.path} for ${name} is missing`);
        const started = Date.now();
        const result = await render(source, variant.options);
        await fs.writeFile(path.join(this.dir, name), result.data);
        Object.assign(variant, {
          width: result.width,
          height: result.height,
          bytes: result.data.length,
          ms: Date.now() - started,
          upscaled: result.upscaled,
          flattened: result.flattened
        });
        await this.save();
        return variant;
      })().finally(() => this.inflight.delete(name));
      this.inflight.set(name, pending);
    }
    return pending;
  }

  /**
   * Stores a file as is (e.g. an SVG passed through), returning its name.
   */
  async storeOriginal(name: string, data: Buffer): Promise<string> {
    const file = path.join(this.dir, name);
    if (!existsSync(file)) await fs.writeFile(file, data);
    return name;
  }

  async read(name: string): Promise<Buffer | null> {
    const file = path.join(this.dir, path.basename(name));
    return existsSync(file) ? fs.readFile(file) : null;
  }

  // Index writes are serialized, so concurrent renders can't interleave them. The index on disk is
  // merged in first, so processes sharing the folder don't drop each other's entries.
  private save(): Promise<void> {
    if (!this.persist) return Promise.resolve();
    this.saving = this.saving.then(async () => {
      const file = path.join(this.dir, INDEX_FILE);
      const merged = new Map<string, CachedVariant>();
      if (existsSync(file)) {
        try {
          for (const v of JSON.parse(await fs.readFile(file, "utf-8")) as CachedVariant[]) merged.set(v.name, v);
        } catch {
          // A corrupt or half-written index is rebuilt from this process's entries
        }
      }
      for (const v of this.variants.values()) {
        const other = merged.get(v.name);
        // Keep whichever entry knows the rendered result
        if (!other || v.bytes !== undefined || other.bytes === undefined) merged.set(v.name, v);
      }
      const temp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(temp, JSON.stringify([...merged.values()], null, 2), "utf-8");
      await fs.rename(temp, file);
    });
    return this.saving;
  }
}
