import { CollectionItem, MediaVariant, SourceMedia } from "../types.js";
import { MediaPreset, TargetDefinition } from "./targets.js";
import { MEDIA_COLLECTION } from "./media-metadata.js";

export type VariantFormat = MediaVariant["format"];

/** One size of one image, as the publisher asks a renderer for it */
export interface VariantRequest {
  preset: string;
  width: number; // pixels
  height?: number; // set for "fill"; "fit" scales inside the width (and this height, if set)
  fit: "fill" | "fit";
  format: VariantFormat;
  quality?: number;
  lossless?: boolean;
  background?: string; // jpeg: color behind transparent areas
  focalPoint?: { x: number; y: number }; // fill: kept as close to the center as the edges allow
}

export interface RenderedVariant {
  content: Buffer;
  width: number;
  height: number;
}

/**
 * Renders image sizes at publish. CDS core doesn't render: a renderer is passed in (e.g.
 * createRenderer from @usecds/imaging). The same source and request must give the same output, so
 * a renderer may cache by them.
 */
export interface MediaRenderer {
  render(source: { virtualPath: string; content: Buffer; mimeType: string; hash: string }, request: VariantRequest): Promise<RenderedVariant>;
}

// Formats CDS renders from; vector images and everything else are published as they are
const RASTER = new Set(["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif", "image/tiff"]);
const EXTENSIONS: Record<VariantFormat, string> = { avif: "avif", webp: "webp", jpeg: "jpg", png: "png" };
export const VARIANT_MIME_TYPES: Record<VariantFormat, string> = { avif: "image/avif", webp: "image/webp", jpeg: "image/jpeg", png: "image/png" };

/** A planned size: the request, and where it lands in the release */
export interface PlannedVariant {
  source: string; // virtual path of the original
  path: string; // virtual path of the rendered file
  breakpoint: string;
  dpr: number;
  request: VariantRequest;
}

function parseAspect(aspect: string): number {
  const [w, h] = aspect.split(":").map(Number);
  if (!(w > 0) || !(h > 0)) throw new Error(`Invalid aspect ratio: ${aspect}`);
  return w / h;
}

/**
 * The sizes the effective targets ask for: every published raster image used by an item of a
 * collection with presets gets each preset's widths (per breakpoint and DPR) in each format. The
 * focal point comes from the image's _media item. Sizes that come out the same share one file.
 */
export function planVariants(
  collections: Record<string, CollectionItem[]>,
  media: SourceMedia[],
  targets: Record<string, TargetDefinition>
): PlannedVariant[] {
  const presets: Record<string, MediaPreset> = {};
  const breakpoints: Record<string, number> = {};
  const dprs = new Set<number>();
  const presetsOf = new Map<string, Set<string>>(); // collection -> preset names
  for (const target of Object.values(targets)) {
    Object.assign(presets, target.media?.presets);
    Object.assign(breakpoints, target.media?.breakpoints);
    for (const dpr of target.media?.dpr ?? []) dprs.add(dpr);
    for (const [collection, rules] of Object.entries(target.collections ?? {})) {
      for (const preset of rules.presets ?? []) presetsOf.set(collection, (presetsOf.get(collection) ?? new Set()).add(preset));
    }
  }
  if (!presetsOf.size) return [];
  if (!dprs.size) dprs.add(1);

  // Which presets each image needs, from the items that use it
  const wanted = new Map<string, Set<string>>();
  for (const [collection, names] of presetsOf) {
    for (const item of collections[collection] ?? []) {
      const paths = [...(item.media ?? []), ...Object.values(item.translations).flatMap((t) => (Array.isArray(t?.media) ? t.media : []))];
      for (const path of paths) for (const name of names) wanted.set(path, (wanted.get(path) ?? new Set()).add(name));
    }
  }

  const focal = new Map((collections[MEDIA_COLLECTION] ?? []).map((m) => [m.id, m.focalPoint as { x: number; y: number } | undefined]));
  const planned: PlannedVariant[] = [];
  for (const file of media) {
    const names = wanted.get(file.virtualPath);
    if (!names || !RASTER.has(file.mimeType)) continue;
    for (const name of [...names].sort()) {
      const preset = presets[name];
      if (!preset) throw new Error(`Preset ${name} (used by ${file.virtualPath}) isn't defined in any target's media.presets`);
      const fit = preset.fit ?? "fill";
      const aspect = preset.aspect ? parseAspect(preset.aspect) : undefined;
      if (fit === "fill" && !aspect) throw new Error(`Preset ${name} fills, so it needs an aspect ratio`);
      for (const [breakpoint, cssWidth] of Object.entries(preset.widths)) {
        if (breakpoints[breakpoint] === undefined) throw new Error(`Preset ${name} uses unknown breakpoint "${breakpoint}"`);
        for (const dpr of [...dprs].sort((a, b) => a - b)) {
          const width = Math.round(cssWidth * dpr);
          const height = aspect ? Math.round(width / aspect) : undefined;
          for (const format of preset.formats?.length ? preset.formats : (["webp"] as VariantFormat[])) {
            const point = focal.get(file.virtualPath);
            const request: VariantRequest = {
              preset: name,
              width,
              fit,
              format,
              ...(height !== undefined ? { height } : {}),
              ...(preset.quality !== undefined ? { quality: preset.quality } : {}),
              ...(preset.lossless !== undefined ? { lossless: preset.lossless } : {}),
              ...(preset.background !== undefined ? { background: preset.background } : {}),
              ...(fit === "fill" && point ? { focalPoint: point } : {})
            };
            planned.push({ source: file.virtualPath, path: `${file.virtualPath}@${name}-${width}w.${EXTENSIONS[format]}`, breakpoint, dpr, request });
          }
        }
      }
    }
  }
  return planned;
}

/**
 * Renders the planned sizes (each file once) and returns them as media, plus the variants per
 * original for its _media item. Throws on the first failed render: the publish fails before writing.
 */
export async function renderVariants(
  planned: PlannedVariant[],
  media: SourceMedia[],
  hashes: Map<string, string>,
  renderer: MediaRenderer
): Promise<{ media: SourceMedia[]; variants: Map<string, MediaVariant[]> }> {
  const byPath = new Map(media.map((m) => [m.virtualPath, m]));
  const rendered = new Map<string, RenderedVariant>();
  const out: SourceMedia[] = [];
  const variants = new Map<string, MediaVariant[]>();
  for (const plan of planned) {
    let result = rendered.get(plan.path);
    if (!result) {
      const source = byPath.get(plan.source)!;
      try {
        result = await renderer.render(
          { virtualPath: source.virtualPath, content: source.content, mimeType: source.mimeType, hash: hashes.get(source.virtualPath)! },
          plan.request
        );
      } catch (err) {
        throw new Error(`Rendering ${plan.path} failed: ${err instanceof Error ? err.message : err}`);
      }
      rendered.set(plan.path, result);
      out.push({ virtualPath: plan.path, content: result.content, mimeType: VARIANT_MIME_TYPES[plan.request.format] });
    }
    const list = variants.get(plan.source) ?? [];
    list.push({
      path: plan.path,
      preset: plan.request.preset,
      breakpoint: plan.breakpoint,
      dpr: plan.dpr,
      width: result.width,
      height: result.height,
      format: plan.request.format
    });
    variants.set(plan.source, list);
  }
  return { media: out, variants };
}
