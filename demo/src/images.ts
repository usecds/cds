import fs from "fs/promises";
import path from "path";
import { CDSClient, MediaInfo } from "@cds/client";
import {
  render,
  responsiveSizes,
  variantKey,
  cropRegion,
  isVector,
  presetFormats,
  mediaBaseName,
  variantFileName,
  MIME_TYPES,
  ImageFormat,
  Preset,
  RenderOptions,
  Point
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
  formats: string; // in delivery order at the largest breakpoint
  storedBytes: number;
  renderMs: number;
  originalBytes: number;
  desktopBytes: number; // what a desktop browser downloads at 1x (smallest supported format)
  mobileBytes: number;
}

// What a page collects while its images are rendered
export interface PageImages {
  prefix: string; // from the page's file back to the site root
  images: Map<string, MediaInfo>; // output file (from the root) -> media shown, for llms.txt
  reports: ImageReport[]; // for the image-report block
}

interface Variant { file: string; format: ImageFormat; width: number; height: number; bytes: number; ms: number }

/**
 * Renders images through the image processor (@cds/imaging) from the target's breakpoints and
 * presets. Variants are named by their variant key, so identical renders happen once per build.
 */
export function createImageRenderer(client: CDSClient, distDir: string, contract: ImageContract) {
  const variants = new Map<string, Variant>();
  const copied = new Set<string>();
  // virtual path -> output file (from the root), for JSON-LD contentUrl
  const mediaUrls = new Map<string, string>();
  const stats = { rendered: 0, reused: 0, skipped: 0, vector: 0 };

  async function picture(
    info: MediaInfo,
    presetName: string,
    imgClass: string,
    page: PageImages,
    crop: { focalPoint?: Point; zoom?: number } = {}
  ): Promise<string> {
    const preset = contract.presets![presetName];
    if (!preset) throw new Error(`Unknown image preset "${presetName}"`);
    const fill = (preset.fit ?? "fill") === "fill";
    const original = await client.getMediaContent(info.path);
    if (!original) throw new Error(`Media ${info.path} missing from the client cache`);
    const alt = escapeHtml(info.alt ?? "");
    // Output names: the _media name or the original file name, plus a short id for caching
    const base = mediaBaseName(info.path, info.name);

    // Vector images scale on their own: serve the original instead of rasterized variants
    if (isVector(info.mimeType)) {
      const file = `media/${variantFileName({ base, key: info.hash, format: info.path.split(".").pop()!.toLowerCase() })}`;
      if (!copied.has(file)) {
        await fs.writeFile(path.join(distDir, file), original);
        copied.add(file);
        stats.vector++;
      }
      page.images.set(file, info);
      mediaUrls.set(info.path, file);
      page.reports.push({
        path: info.path, preset: "original (vector)", variants: 0, formats: "svg",
        storedBytes: original.length, renderMs: 0, originalBytes: original.length,
        desktopBytes: original.length, mobileBytes: original.length
      });
      return `<img src="${page.prefix}${file}" alt="${alt}" width="${info.width ?? ""}" height="${info.height ?? ""}" class="${imgClass}">`;
    }

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

    // breakpoint min width (largest first) -> format -> candidates per pixel ratio
    const groups = new Map<number, Map<ImageFormat, (Variant & { dpr: number })[]>>();
    const used = new Set<Variant>();
    for (const { size, format, options, key } of planned) {
      let variant = variants.get(key);
      if (variant) {
        stats.reused++;
      } else {
        const started = Date.now();
        const result = await render(original, options);
        if (result.upscaled) {
          console.log(`⚠️  [Imaging] ${info.path} ${presetName}@${size.breakpoint} is upscaled to ${result.width}px`);
        }
        if (result.flattened) {
          console.log(`⚠️  [Imaging] ${info.path} ${presetName} as ${format}: transparency flattened onto ${preset.background ?? "#ffffff"}`);
        }
        // Name and MIME type follow the requested format (sharp reports AVIF as "heif")
        const width = (sizesPerFormat.get(format) ?? 0) > 1 ? size.width : undefined;
        variant = {
          file: `media/${variantFileName({ base, preset: presetName, width, key, format })}`,
          format,
          width: result.width,
          height: result.height,
          bytes: result.data.length,
          ms: Date.now() - started
        };
        await fs.writeFile(path.join(distDir, variant.file), result.data);
        variants.set(key, variant);
        stats.rendered++;
      }
      used.add(variant);
      const byFormat = groups.get(size.minWidth) ?? new Map();
      byFormat.set(format, [...(byFormat.get(format) ?? []), { ...variant, dpr: size.dpr }]);
      groups.set(size.minWidth, byFormat);
    }

    // The browser takes the first <source> whose media and type match, so within each breakpoint
    // the formats go smallest file first: every browser gets the smallest format it supports.
    const entries = [...groups.entries()];
    const srcset = (candidates: { file: string; dpr: number }[]) =>
      candidates.map((c) => `${page.prefix}${c.file} ${c.dpr}x`).join(", ");
    const bySize = (byFormat: Map<ImageFormat, (Variant & { dpr: number })[]>) =>
      [...byFormat.entries()].sort(([, a], [, b]) => a[0].bytes - b[0].bytes);
    const sources = entries.flatMap(([minWidth, byFormat], i) => {
      const media = i < entries.length - 1 ? ` media="(min-width: ${minWidth}px)"` : "";
      return bySize(byFormat).map(([format, candidates]) =>
        `<source${media} type="${MIME_TYPES[format]}" srcset="${srcset(candidates)}" width="${candidates[0].width}" height="${candidates[0].height}">`);
    });
    // <img> fallback: smallest breakpoint in the last listed (most widely supported) format
    const fallback = entries[entries.length - 1][1].get(formats[formats.length - 1])!;
    page.images.set(fallback[0].file, info);
    if (!mediaUrls.has(info.path)) mediaUrls.set(info.path, entries[0][1].get(formats[formats.length - 1])![0].file);

    const smallest1x = (byFormat: Map<ImageFormat, (Variant & { dpr: number })[]>) => bySize(byFormat)[0][1][0].bytes;
    page.reports.push({
      path: info.path,
      preset: presetName,
      variants: used.size,
      formats: bySize(entries[0][1]).map(([format]) => format).join(" → "),
      storedBytes: [...used].reduce((sum, v) => sum + v.bytes, 0),
      renderMs: [...used].reduce((sum, v) => sum + v.ms, 0),
      originalBytes: original.length,
      desktopBytes: smallest1x(entries[0][1]),
      mobileBytes: smallest1x(entries[entries.length - 1][1])
    });
    return `<picture>${sources.join("")}<img src="${page.prefix}${fallback[0].file}" srcset="${srcset(fallback)}" alt="${alt}" width="${fallback[0].width}" height="${fallback[0].height}" class="${imgClass}"></picture>`;
  }

  return { picture, mediaUrls, stats };
}
