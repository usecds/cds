import fs from "fs/promises";
import path from "path";
import { ImageFormat, render, variantKey } from "./index.js";

/** One size of one image, as the CDS publisher asks for it (VariantRequest in @usecds/server) */
export interface RendererRequest {
  preset: string;
  width: number;
  height?: number;
  fit: "fill" | "fit";
  format: ImageFormat;
  quality?: number;
  lossless?: boolean;
  background?: string;
  focalPoint?: { x: number; y: number };
}

/** A MediaRenderer for the CDS publisher (PublishOptions.renderer in @usecds/server) */
export interface Renderer {
  render(
    source: { virtualPath: string; content: Buffer; mimeType: string; hash: string },
    request: RendererRequest
  ): Promise<{ content: Buffer; width: number; height: number }>;
}

/**
 * The publisher's renderer: sharp, keyed by the original's hash and the effective options
 * (variantKey). With a cache folder, a size rendered once is read back on the next publish
 * instead of being rendered again.
 */
export function createRenderer(options: { cacheDir?: string } = {}): Renderer {
  return {
    async render(source, request) {
      const renderOptions = {
        width: request.width,
        fit: request.fit,
        format: request.format,
        ...(request.height !== undefined ? { height: request.height } : {}),
        ...(request.focalPoint ? { focalPoint: request.focalPoint } : {}),
        ...(request.quality !== undefined ? { quality: request.quality } : {}),
        ...(request.lossless !== undefined ? { lossless: request.lossless } : {}),
        ...(request.background !== undefined ? { background: request.background } : {})
      };
      const key = variantKey(source.hash, renderOptions);
      const file = options.cacheDir ? path.join(options.cacheDir, `${key}.${request.format}`) : undefined;
      if (file) {
        try {
          const [content, meta] = await Promise.all([fs.readFile(file), fs.readFile(`${file}.json`, "utf-8")]);
          const { width, height } = JSON.parse(meta) as { width: number; height: number };
          return { content, width, height };
        } catch {
          // not cached yet
        }
      }
      const result = await render(source.content, renderOptions);
      if (file) {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, result.data);
        await fs.writeFile(`${file}.json`, JSON.stringify({ width: result.width, height: result.height }));
      }
      return { content: result.data, width: result.width, height: result.height };
    }
  };
}
