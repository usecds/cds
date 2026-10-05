import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { cropRegion, responsiveSizes, variantKey, render, parseAspect, isVector, presetFormats, fitSize, VariantCache } from "../imaging/src/index.js";
import fs from "fs/promises";
import os from "os";
import path from "path";

// 300x200 test image: left half red, right half blue
async function testImage(): Promise<Buffer> {
  const half = (color: string) => sharp({ create: { width: 150, height: 200, channels: 3, background: color } }).png().toBuffer();
  return sharp({ create: { width: 300, height: 200, channels: 3, background: "#000" } })
    .composite([
      { input: await half("#ff0000"), left: 0, top: 0 },
      { input: await half("#0000ff"), left: 150, top: 0 }
    ])
    .png()
    .toBuffer();
}

describe("Image processor (@usecds/imaging)", () => {
  it("crops the largest region of the output aspect, centered on the focal point and clamped", () => {
    // 1536x1024 source, square output: 1024x1024 region
    expect(cropRegion(1536, 1024, 1, { x: 0.5, y: 0.5 })).toEqual({ left: 256, top: 0, width: 1024, height: 1024 });
    expect(cropRegion(1536, 1024, 1, { x: 0.87, y: 0.18 })).toEqual({ left: 512, top: 0, width: 1024, height: 1024 });
    // Zoom 2 shrinks the region, so the focal point can be centered
    expect(cropRegion(1536, 1024, 1, { x: 0.87, y: 0.18 }, 2)).toEqual({ left: 1024, top: 0, width: 512, height: 512 });
    // Wide output from a less wide source crops vertically
    expect(cropRegion(1536, 1024, 3, { x: 0.33, y: 0.39 })).toEqual({ left: 0, top: 143, width: 1536, height: 512 });
    expect(() => cropRegion(100, 100, 1, undefined, 0.5)).toThrow(/zoom/);
  });

  it("lists responsive sizes per breakpoint and pixel ratio, largest breakpoint first", () => {
    const sizes = responsiveSizes(
      { aspect: "3:1", widths: { mobile: 400, desktop: 1200 } },
      { mobile: 0, tablet: 768, desktop: 1280 },
      [1, 2]
    );
    expect(sizes).toEqual([
      { breakpoint: "desktop", minWidth: 1280, dpr: 1, width: 1200, height: 400 },
      { breakpoint: "desktop", minWidth: 1280, dpr: 2, width: 2400, height: 800 },
      { breakpoint: "mobile", minWidth: 0, dpr: 1, width: 400, height: 133 },
      { breakpoint: "mobile", minWidth: 0, dpr: 2, width: 800, height: 267 }
    ]);
    expect(() => responsiveSizes({ aspect: "1:1", widths: { xl: 100 } }, { md: 768 })).toThrow(/unknown breakpoint "xl"/);
    expect(() => responsiveSizes({ widths: { md: 100 } }, { md: 768 })).toThrow(/needs an aspect ratio/);
    expect(parseAspect("21:9")).toBeCloseTo(21 / 9);
  });

  it("identifies vector images, which are passed through instead of rendered", () => {
    expect(isVector("image/svg+xml")).toBe(true);
    expect(isVector("IMAGE/SVG+XML")).toBe(true);
    expect(isVector("image/png")).toBe(false);
    expect(isVector("image/webp")).toBe(false);
  });

  it("derives variant keys from the options that affect the output", () => {
    const base = { width: 400, height: 400, focalPoint: { x: 0.2, y: 0.5 } };
    expect(variantKey("src", base)).toBe(variantKey("src", { ...base }));
    expect(variantKey("src", base)).not.toBe(variantKey("src", { ...base, focalPoint: { x: 0.8, y: 0.5 } }));
    expect(variantKey("src", base)).not.toBe(variantKey("other", base));
    // The focal point doesn't affect "fit" renders
    const fit = { width: 400, fit: "fit" as const };
    expect(variantKey("src", { ...fit, focalPoint: { x: 0.1, y: 0.1 } })).toBe(variantKey("src", fit));
  });

  it("renders crops around the focal point", async () => {
    const input = await testImage();
    // Color at the center of the rendered image
    const pixel = async (data: Buffer) => {
      const { data: raw, info } = await sharp(data).raw().toBuffer({ resolveWithObject: true });
      const i = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels;
      return [raw[i], raw[i + 1], raw[i + 2]];
    };

    const left = await render(input, { width: 100, height: 100, focalPoint: { x: 0.1, y: 0.5 }, format: "png" });
    const right = await render(input, { width: 100, height: 100, focalPoint: { x: 0.9, y: 0.5 }, format: "png" });
    expect([left.width, left.height, left.format]).toEqual([100, 100, "png"]);
    expect(await pixel(left.data)).toEqual([255, 0, 0]);
    expect(await pixel(right.data)).toEqual([0, 0, 255]);
    expect(left.upscaled).toBe(false);

    // A 2x zoomed 200px crop needs more pixels than the 100px region has
    const zoomed = await render(input, { width: 200, height: 200, zoom: 2 });
    expect(zoomed.upscaled).toBe(true);

    // fit scales inside the box without cropping or enlarging
    const fitted = await render(input, { width: 150, fit: "fit" });
    expect([fitted.width, fitted.height]).toEqual([150, 100]);
  });

  it("renders the requested formats, lossless on request, and flattens transparency for jpeg", async () => {
    const transparent = await sharp({ create: { width: 40, height: 40, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .png()
      .toBuffer();

    const avif = await render(transparent, { width: 20, height: 20, format: "avif" });
    expect(avif.format).toBe("heif"); // sharp reports AVIF as its container format
    expect((await sharp(avif.data).metadata()).compression).toBe("av1");

    const jpeg = await render(transparent, { width: 20, height: 20, format: "jpeg", background: "#ff0000" });
    expect(jpeg.flattened).toBe(true);
    const { data } = await sharp(jpeg.data).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(240); // red background instead of black
    expect(data[1]).toBeLessThan(20);

    const webp = await render(transparent, { width: 20, height: 20, format: "webp" });
    expect(webp.flattened).toBe(false);
    expect((await sharp(webp.data).metadata()).hasAlpha).toBe(true);
  });

  it("keys variants by the options that matter for each format", () => {
    const base = { width: 100, height: 100 };
    expect(variantKey("s", { ...base, format: "webp", lossless: true }))
      .not.toBe(variantKey("s", { ...base, format: "webp" }));
    // png without lossless is palette-quantized, so lossless changes it
    expect(variantKey("s", { ...base, format: "png" })).not.toBe(variantKey("s", { ...base, format: "png", lossless: true }));
    // default quality is per format: an explicit default gives the same key
    expect(variantKey("s", { ...base, format: "avif" })).toBe(variantKey("s", { ...base, format: "avif", quality: 50 }));
    // background only matters for jpeg
    expect(variantKey("s", { ...base, format: "webp", background: "#000" })).toBe(variantKey("s", { ...base, format: "webp" }));
    expect(variantKey("s", { ...base, format: "jpeg", background: "#000" })).not.toBe(variantKey("s", { ...base, format: "jpeg" }));
    expect(presetFormats({ widths: { m: 1 } })).toEqual(["webp"]);
    expect(presetFormats({ widths: { m: 1 }, formats: ["avif", "webp"] })).toEqual(["avif", "webp"]);
  });
});

describe("VariantCache", () => {
  const options = { width: 60, height: 40, format: "png" as const };

  it("registers without rendering, renders on request once, and survives a reopen", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cds-variant-cache-"));
    try {
      const source = await testImage();
      let loads = 0;
      const loadSource = async () => { loads++; return source; };

      const cache = await VariantCache.open(dir, { persist: true });
      cache.register({ name: "test-60.abc.png", key: "k1", path: "test.png", options, format: "png", width: 60, height: 40 });
      expect(cache.isRendered("test-60.abc.png")).toBe(false);
      expect(await fs.readdir(dir)).toEqual([]);

      // Parallel requests share one render
      const [a, b] = await Promise.all([cache.ensure("test-60.abc.png", loadSource), cache.ensure("test-60.abc.png", loadSource)]);
      expect(a).toBe(b);
      expect(loads).toBe(1);
      expect(a.bytes).toBeGreaterThan(0);
      expect((await cache.read("test-60.abc.png"))?.length).toBe(a.bytes);

      // A new process knows the variant and doesn't render it again
      const reopened = await VariantCache.open(dir, { persist: true });
      expect(reopened.isRendered("test-60.abc.png")).toBe(true);
      await reopened.ensure("test-60.abc.png", loadSource);
      expect(loads).toBe(1);

      // Without the file, the variant counts as not rendered and is rendered again
      await fs.rm(path.join(dir, "test-60.abc.png"));
      const third = await VariantCache.open(dir, { persist: true });
      expect(third.isRendered("test-60.abc.png")).toBe(false);
      await third.ensure("test-60.abc.png", loadSource);
      expect(loads).toBe(2);
      await expect(third.ensure("unknown.png", loadSource)).rejects.toThrow(/Unknown variant/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("writes no index unless asked to", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cds-variant-cache-"));
    try {
      const cache = await VariantCache.open(dir);
      cache.register({ name: "x.png", key: "k", path: "x.png", options, format: "png", width: 60, height: 40 });
      await cache.ensure("x.png", async () => testImage());
      expect(await fs.readdir(dir)).toEqual(["x.png"]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("computes fit sizes before rendering", () => {
    expect(fitSize(1900, 900, 640)).toEqual({ width: 640, height: 303 });
    expect(fitSize(1900, 900, 2304)).toEqual({ width: 1900, height: 900 }); // never enlarged
    expect(fitSize(1000, 1000, 800, 400)).toEqual({ width: 400, height: 400 });
  });
});
