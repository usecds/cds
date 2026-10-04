import { CDSClient, MediaInfo } from "@cds/client";
import {
  responsiveSizes,
  variantKey,
  cropRegion,
  fitSize,
  isVector,
  presetFormats,
  mediaBaseName,
  variantFileName,
  MIME_TYPES,
  ImageFormat,
  Preset,
  RenderOptions,
  Point,
  VariantCache,
  CachedVariant
} from "@cds/imaging";
import { escapeHtml } from "./paths.js";

export interface ImageContract {
  breakpoints?: Record<string, number>;
  dpr?: number[];
  presets?: Record<string, Preset>;
}

export interface ImageReport {
  path: string;
  preset: string;
  variants: number;
  pending: number; // planned but not rendered yet (lazy mode)
  formats: string; // in delivery order at the largest breakpoint
  storedBytes: number; // rendered variants only
  renderMs: number;
  originalBytes: number;
  desktopBytes?: number; // what a desktop browser downloads at 1x (smallest rendered format)
  mobileBytes?: number;
}

// What a page collects while its images are rendered
export interface PageImages {
  prefix: string; // from the page's file back to the site root
  images: Map<string, MediaInfo>; // output file (from the root) -> media shown, for llms.txt
  reports: ImageReport[]; // for the image-report block
}

// "high": above the fold (hero), loaded first; "lazy": loaded when scrolled near
export type ImagePriority = "high" | "lazy";

/**
 * Renders images through the image processor (@cds/imaging) from the target's breakpoints and
 * presets, into a VariantCache. Eager: every variant is rendered while the page is rendered
 * (static build, image pre-generation). Lazy: variants are only planned; the server renders each
 * one when it's first requested.
 */
export function createImageRenderer(
  client: CDSClient,
  cache: VariantCache,
  contract: ImageContract,
  options: { eager: boolean }
) {
  // virtual path -> output file (from the root), for JSON-LD contentUrl
  const mediaUrls = new Map<string, string>();
  const stats = { rendered: 0, reused: 0, pending: 0, skipped: 0, vector: 0 };
  const loadSource = (virtualPath: string) => client.getMediaContent(virtualPath);

  async function picture(
    info: MediaInfo,
    presetName: string,
    imgClass: string,
    page: PageImages,
    crop: { focalPoint?: Point; zoom?: number } = {},
    priority: ImagePriority = "lazy"
  ): Promise<string> {
    const preset = contract.presets![presetName];
    if (!preset) throw new Error(`Unknown image preset "${presetName}"`);
    const fill = (preset.fit ?? "fill") === "fill";
    const alt = escapeHtml(info.alt ?? "");
    const loading = priority === "high" ? ' loading="eager" fetchpriority="high"' : ' loading="lazy" decoding="async"';
    // Output names: the _media name or the original file name, plus a short id for caching
    const base = mediaBaseName(info.path, info.name);

    // Vector images scale on their own: serve the original instead of rasterized variants
    if (isVector(info.mimeType)) {
      const original = await loadSource(info.path);
      if (!original) throw new Error(`Media ${info.path} missing from the client cache`);
      const name = variantFileName({ base, key: info.hash, format: info.path.split(".").pop()!.toLowerCase() });
      await cache.storeOriginal(name, original);
      stats.vector++;
      const file = `media/${name}`;
      page.images.set(file, info);
      mediaUrls.set(info.path, file);
      page.reports.push({
        path: info.path, preset: "original (vector)", variants: 0, pending: 0, formats: "svg",
        storedBytes: original.length, renderMs: 0, originalBytes: original.length,
        desktopBytes: original.length, mobileBytes: original.length
      });
      return `<img src="${page.prefix}${file}" alt="${alt}" width="${info.width ?? ""}" height="${info.height ?? ""}"${loading} class="${imgClass}">`;
    }

    // Plan: every size per breakpoint, pixel ratio and format
    const formats = presetFormats(preset);
    const focalPoint = crop.focalPoint ?? info.focalPoint;
    const planned: { size: ReturnType<typeof responsiveSizes>[number]; format: ImageFormat; options: RenderOptions; key: string }[] = [];
    for (const size of responsiveSizes(preset, contract.breakpoints!, contract.dpr)) {
      // Higher pixel ratios only help if the source has the pixels
      const available = fill && info.width && info.height
        ? cropRegion(info.width, info.height, size.width / size.height!, focalPoint, crop.zoom).width
        : info.width;
      if (size.dpr > 1 && available && size.width > available) {
        stats.skipped += formats.length;
        continue;
      }
      for (const format of formats) {
        const options: RenderOptions = {
          width: size.width,
          height: size.height,
          fit: preset.fit,
          focalPoint,
          zoom: crop.zoom,
          format,
          quality: preset.quality,
          lossless: preset.lossless,
          background: preset.background
        };
        planned.push({ size, format, options, key: variantKey(info.hash, options) });
      }
    }
    // The width is only part of the name when one format has several sizes
    const sizesPerFormat = new Map<ImageFormat, number>();
    for (const p of planned) sizesPerFormat.set(p.format, (sizesPerFormat.get(p.format) ?? 0) + 1);

    // Register (and in eager mode render) each variant
    const groups = new Map<number, Map<ImageFormat, (CachedVariant & { dpr: number })[]>>();
    const used = new Set<CachedVariant>();
    for (const { size, format, options: renderOptions, key } of planned) {
      const name = variantFileName({ base, preset: presetName, width: (sizesPerFormat.get(format) ?? 0) > 1 ? size.width : undefined, key, format });
      const planSize = fill || !info.width || !info.height
        ? { width: size.width, height: size.height }
        : fitSize(info.width, info.height, size.width, size.height);
      let variant = cache.register({ name, key, path: info.path, options: renderOptions, format, ...planSize });

      if (cache.isRendered(name)) {
        stats.reused++;
      } else if (options.eager) {
        variant = await cache.ensure(name, loadSource);
        stats.rendered++;
        if (variant.upscaled) console.log(`⚠️  [Imaging] ${info.path} ${presetName}@${size.breakpoint} is upscaled to ${variant.width}px`);
        if (variant.flattened) console.log(`⚠️  [Imaging] ${info.path} ${presetName} as ${format}: transparency flattened onto ${preset.background ?? "#ffffff"}`);
      } else {
        stats.pending++;
      }
      used.add(variant);
      const byFormat = groups.get(size.minWidth) ?? new Map();
      byFormat.set(format, [...(byFormat.get(format) ?? []), { ...variant, dpr: size.dpr }]);
      groups.set(size.minWidth, byFormat);
    }

    // The browser takes the first <source> whose media and type match, so within each breakpoint
    // the formats go smallest file first. Sizes of variants not rendered yet are unknown: those
    // keep the declared order until they exist.
    const entries = [...groups.entries()];
    const file = (v: CachedVariant) => `media/${v.name}`;
    const srcset = (candidates: (CachedVariant & { dpr: number })[]) =>
      candidates.map((c) => `${page.prefix}${file(c)} ${c.dpr}x`).join(", ");
    const bySize = (byFormat: Map<ImageFormat, (CachedVariant & { dpr: number })[]>) =>
      [...byFormat.entries()].sort(([, a], [, b]) =>
        a[0].bytes === undefined || b[0].bytes === undefined ? 0 : a[0].bytes - b[0].bytes);
    const sources = entries.flatMap(([minWidth, byFormat], i) => {
      const media = i < entries.length - 1 ? ` media="(min-width: ${minWidth}px)"` : "";
      return bySize(byFormat).map(([format, candidates]) =>
        `<source${media} type="${MIME_TYPES[format]}" srcset="${srcset(candidates)}" width="${candidates[0].width}" height="${candidates[0].height ?? ""}">`);
    });
    // <img> fallback: smallest breakpoint in the last listed (most widely supported) format
    const fallback = entries[entries.length - 1][1].get(formats[formats.length - 1])!;
    page.images.set(file(fallback[0]), info);
    if (!mediaUrls.has(info.path)) mediaUrls.set(info.path, file(entries[0][1].get(formats[formats.length - 1])![0]));

    const smallest1x = (byFormat: Map<ImageFormat, (CachedVariant & { dpr: number })[]>) => {
      const known = [...byFormat.values()].map((c) => c[0].bytes).filter((b): b is number => b !== undefined);
      return known.length ? Math.min(...known) : undefined;
    };
    const rendered = [...used].filter((v) => v.bytes !== undefined);
    page.reports.push({
      path: info.path,
      preset: presetName,
      variants: used.size,
      pending: used.size - rendered.length,
      formats: bySize(entries[0][1]).map(([format]) => format).join(" → "),
      storedBytes: rendered.reduce((sum, v) => sum + v.bytes!, 0),
      renderMs: rendered.reduce((sum, v) => sum + (v.ms ?? 0), 0),
      originalBytes: (await loadSource(info.path))?.length ?? 0,
      desktopBytes: smallest1x(entries[0][1]),
      mobileBytes: smallest1x(entries[entries.length - 1][1])
    });
    return `<picture>${sources.join("")}<img src="${page.prefix}${file(fallback[0])}" srcset="${srcset(fallback)}" alt="${alt}" width="${fallback[0].width}" height="${fallback[0].height ?? ""}"${loading} class="${imgClass}"></picture>`;
  }

  return { picture, mediaUrls, stats, cache, loadSource };
}
