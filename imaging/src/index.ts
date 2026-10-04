import crypto from "crypto";
import sharp, { Sharp } from "sharp";

export interface Point {
  x: number; // 0..1
  y: number; // 0..1
}

export interface RenderOptions {
  width: number; // output width in pixels
  height?: number; // required for "fill"; for "fit" it only bounds the height
  fit?: "fill" | "fit"; // fill: crop to exactly width x height (default); fit: scale inside, no crop
  focalPoint?: Point; // fill only: point kept as close to the center as the image edges allow
  zoom?: number; // fill only: >= 1, crops a smaller region around the focal point (default 1)
  format?: "webp" | "jpeg" | "png" | "avif"; // default webp
  quality?: number; // 1..100, default 80
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
}

// Image preset as declared in a target definition's media.presets
export interface Preset {
  aspect?: string; // "3:1"; required for fill
  fit?: "fill" | "fit";
  widths: Record<string, number>; // breakpoint name -> rendered width in CSS pixels
  format?: RenderOptions["format"];
  quality?: number;
}

export interface ResponsiveSize {
  breakpoint: string;
  minWidth: number; // screen width from which this size applies (CSS pixels)
  dpr: number; // device pixel ratio
  width: number; // pixels to render
  height?: number;
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

/**
 * Canonical form of the options, containing only what affects the output:
 * focal point and zoom matter for "fill" only.
 */
export function canonicalOptions(options: RenderOptions): string {
  const fit = options.fit ?? "fill";
  const parts = [
    `w${options.width}`,
    `h${options.height ?? "auto"}`,
    fit,
    `f${options.format ?? "webp"}`,
    `q${options.quality ?? 80}`
  ];
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
  const { data, info } = await pipeline
    .toFormat(format, { quality: options.quality ?? 80 })
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, format: info.format, upscaled };
}
