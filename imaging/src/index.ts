import crypto from "crypto";
import sharp, { Sharp } from "sharp";

export interface Point {
  x: number; // 0..1
  y: number; // 0..1
}

export type ImageFormat = "avif" | "webp" | "jpeg" | "png";

export const MIME_TYPES: Record<ImageFormat, string> = {
  avif: "image/avif",
  webp: "image/webp",
  jpeg: "image/jpeg",
  png: "image/png"
};

// Quality scales differ per format: AVIF 50 looks roughly like WebP/JPEG 80 at about half the size
export const DEFAULT_QUALITY: Record<ImageFormat, number> = { avif: 50, webp: 80, jpeg: 80, png: 80 };

export interface RenderOptions {
  width: number; // output width in pixels
  height?: number; // required for "fill"; for "fit" it only bounds the height
  fit?: "fill" | "fit"; // fill: crop to exactly width x height (default); fit: scale inside, no crop
  focalPoint?: Point; // fill only: point kept as close to the center as the image edges allow
  zoom?: number; // fill only: >= 1, crops a smaller region around the focal point (default 1)
  format?: ImageFormat; // default webp
  quality?: number; // 1..100, default per format (DEFAULT_QUALITY); ignored when lossless
  lossless?: boolean; // webp/avif/png; png without it is palette-quantized (lossy); ignored for jpeg
  background?: string; // jpeg only: color behind transparent areas (default #ffffff)
}

export interface Region {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface RenderResult {
  data: Buffer;
  width: number;
  height: number;
  format: string;
  upscaled: boolean; // the output is larger than the source region it came from
  flattened: boolean; // a transparent source was flattened onto the background (jpeg)
}

// Image preset as declared in a target definition's media.presets
export interface Preset {
  aspect?: string; // "3:1"; required for fill
  fit?: "fill" | "fit";
  widths: Record<string, number>; // breakpoint name -> rendered width in CSS pixels
  formats?: ImageFormat[]; // candidates, the last one is the universal fallback (default ["webp"])
  quality?: number;
  lossless?: boolean; // e.g. diagrams and screenshots, where lossy compression blurs text
  background?: string; // jpeg: color behind transparent areas
}

export interface ResponsiveSize {
  breakpoint: string;
  minWidth: number; // screen width from which this size applies (CSS pixels)
  dpr: number; // device pixel ratio
  width: number; // pixels to render
  height?: number;
}

const VECTOR_TYPES = new Set(["image/svg+xml"]);

/**
 * Vector images scale to any size on their own, and rasterizing makes them larger and blurrier.
 * Generators should pass them through unchanged instead of rendering variants.
 */
export function isVector(mimeType: string): boolean {
  return VECTOR_TYPES.has(mimeType.toLowerCase());
}

/**
 * The part of a source image a "fill" render keeps: the largest region with the output's
 * aspect ratio, shrunk by zoom, centered on the focal point and clamped to the image edges.
 */
export function cropRegion(
  sourceWidth: number,
  sourceHeight: number,
  outputAspect: number,
  focalPoint: Point = { x: 0.5, y: 0.5 },
  zoom = 1
): Region {
  if (zoom < 1) throw new Error(`zoom must be >= 1, got ${zoom}`);
  const sourceAspect = sourceWidth / sourceHeight;
  let width = sourceAspect > outputAspect ? sourceHeight * outputAspect : sourceWidth;
  let height = sourceAspect > outputAspect ? sourceHeight : sourceWidth / outputAspect;
  width = Math.max(1, Math.round(width / zoom));
  height = Math.max(1, Math.round(height / zoom));

  const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max);
  const left = clamp(Math.round(focalPoint.x * sourceWidth - width / 2), sourceWidth - width);
  const top = clamp(Math.round(focalPoint.y * sourceHeight - height / 2), sourceHeight - height);
  return { left, top, width, height };
}

// "3:1" -> 3
export function parseAspect(aspect: string): number {
  const [w, h] = aspect.split(":").map(Number);
  if (!(w > 0) || !(h > 0)) throw new Error(`Invalid aspect ratio: ${aspect}`);
  return w / h;
}

/**
 * Every size a preset needs: one per breakpoint and device pixel ratio, largest breakpoint first
 * (the order <picture> sources need).
 */
export function responsiveSizes(
  preset: Preset,
  breakpoints: Record<string, number>,
  dprs: number[] = [1]
): ResponsiveSize[] {
  const aspect = preset.aspect ? parseAspect(preset.aspect) : undefined;
  if ((preset.fit ?? "fill") === "fill" && !aspect) throw new Error("A fill preset needs an aspect ratio");

  const sizes: ResponsiveSize[] = [];
  for (const [breakpoint, cssWidth] of Object.entries(preset.widths)) {
    const minWidth = breakpoints[breakpoint];
    if (minWidth === undefined) throw new Error(`Preset uses unknown breakpoint "${breakpoint}"`);
    for (const dpr of dprs) {
      const width = Math.round(cssWidth * dpr);
      sizes.push({ breakpoint, minWidth, dpr, width, height: aspect ? Math.round(width / aspect) : undefined });
    }
  }
  return sizes.sort((a, b) => b.minWidth - a.minWidth || a.dpr - b.dpr);
}

// Formats a preset renders, in declared order; the last one is the fallback for <img>
export function presetFormats(preset: Preset): ImageFormat[] {
  return preset.formats?.length ? preset.formats : ["webp"];
}

/**
 * Canonical form of the options, containing only what affects the output:
 * focal point and zoom matter for "fill" only, lossless for webp/avif, background for jpeg.
 */
export function canonicalOptions(options: RenderOptions): string {
  const fit = options.fit ?? "fill";
  const format = options.format ?? "webp";
  const lossless = !!options.lossless && format !== "jpeg";
  const parts = [
    `w${options.width}`,
    `h${options.height ?? "auto"}`,
    fit,
    `f${format}`,
    lossless ? "lossless" : `q${options.quality ?? DEFAULT_QUALITY[format]}`
  ];
  if (format === "jpeg") parts.push(`bg${options.background ?? "#ffffff"}`);
  if (fit === "fill") {
    const point = options.focalPoint ?? { x: 0.5, y: 0.5 };
    parts.push(`fp${point.x},${point.y}`, `z${options.zoom ?? 1}`);
  }
  return parts.join("_");
}

/**
 * Identity of a variant, known before rendering: same source + same effective options = same key.
 */
export function variantKey(sourceHash: string, options: RenderOptions): string {
  return crypto.createHash("sha256").update(`${sourceHash}:${canonicalOptions(options)}`).digest("hex");
}

/**
 * Renders one variant. Pure: same input and options produce the same output.
 */
export async function render(input: Buffer, options: RenderOptions): Promise<RenderResult> {
  const meta = await sharp(input).metadata();
  if (!meta.width || !meta.height) throw new Error("Unable to read image dimensions");
  // EXIF orientations 5-8 swap width and height once rotated
  const swapped = (meta.orientation ?? 1) >= 5;
  const sourceWidth = swapped ? meta.height : meta.width;
  const sourceHeight = swapped ? meta.width : meta.height;

  const image = sharp(input).rotate();
  let pipeline: Sharp;
  let upscaled: boolean;
  if ((options.fit ?? "fill") === "fill") {
    if (!options.height) throw new Error("fill needs a height");
    const region = cropRegion(sourceWidth, sourceHeight, options.width / options.height, options.focalPoint, options.zoom);
    pipeline = image.extract(region).resize(options.width, options.height, { fit: "fill" });
    upscaled = options.width > region.width;
  } else {
    pipeline = image.resize(options.width, options.height, { fit: "inside", withoutEnlargement: true });
    upscaled = false;
  }

  const format = options.format ?? "webp";
  // JPEG has no transparency: fill transparent areas with the background instead of black
  const flattened = format === "jpeg" && !!meta.hasAlpha;
  if (flattened) pipeline = pipeline.flatten({ background: options.background ?? "#ffffff" });

  // Lossless PNG is plain PNG; a quality makes sharp quantize it to a palette (lossy)
  const lossless = !!options.lossless && format !== "jpeg";
  const encoder = lossless
    ? format === "png" ? {} : { lossless: true }
    : { quality: options.quality ?? DEFAULT_QUALITY[format] };
  const { data, info } = await pipeline.toFormat(format, encoder).toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, format: info.format, upscaled, flattened };
}
