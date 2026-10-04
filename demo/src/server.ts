import fs from "fs/promises";
import path from "path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { CDSClient } from "@cds/client";
import { createImageRenderer, ImageContract } from "./images.js";
import { renderRoute } from "./site.js";
import { buildLlmsTxt, buildSitemap } from "./outputs.js";

const MIME: Record<string, string> = { avif: "image/avif", webp: "image/webp", png: "image/png", jpg: "image/jpeg", svg: "image/svg+xml" };

/**
 * Server mode (SSR with Hono): every request path is resolved through the client's routes at
 * request time, so a newly synced release is live without a rebuild. Images are rendered on first
 * use into mediaDir and served from /media/.
 */
export function startServer(options: {
  client: CDSClient;
  contract: ImageContract;
  mediaDir: string;
  port: number;
  channel: string;
  syncIntervalMs: number;
}) {
  const { client, contract, mediaDir, port, channel } = options;
  let renderer = createImageRenderer(client, path.dirname(mediaDir), contract);
  const app = new Hono();

  app.get("/media/:file", async (c) => {
    const file = path.basename(c.req.param("file"));
    try {
      const data = await fs.readFile(path.join(mediaDir, file));
      return c.body(data, 200, {
        "Content-Type": MIME[file.split(".").pop()!] ?? "application/octet-stream",
        // Names carry a content id, so they never change
        "Cache-Control": "public, max-age=31536000, immutable"
      });
    } catch {
      return c.notFound();
    }
  });

  app.get("/llms.txt", async (c) => c.text(await buildLlmsTxt(client, renderer, contract, "server")));
  app.get("/sitemap.xml", (c) => c.body(buildSitemap(client), 200, { "Content-Type": "application/xml" }));

  // Every other path: resolved through _routes
  app.get("*", async (c) => {
    const resolved = await client.resolveRoute(c.req.path);
    if (!resolved) return c.html("<h1>404</h1><p>No route for this path.</p>", 404);
    if (resolved.redirect) return c.redirect(resolved.redirect.path, resolved.redirect.status);
    const page = await renderRoute(client, renderer, contract, resolved.route, resolved.locale, "server");
    return page ? c.html(page.html) : c.notFound();
  });

  // Keep the release current: a new release is served as soon as it's synced
  setInterval(async () => {
    const result = await client.sync(channel);
    if (result.updated) {
      renderer = createImageRenderer(client, path.dirname(mediaDir), contract);
      console.log(`🔄 [Server] Now serving release ${result.releaseId}`);
    }
  }, options.syncIntervalMs).unref();

  const server = serve({ fetch: app.fetch, port }, (info) => {
    console.log(`🌐 [Hono] Serving the demo at http://localhost:${info.port}/ (routes from _routes, Ctrl+C to stop)`);
    for (const route of client.getRoutes()) {
      for (const [locale, routePath] of Object.entries(route.paths)) {
        console.log(`   ${locale}  http://localhost:${info.port}${routePath}${route.redirect ? "  (redirect)" : ""}`);
      }
    }
  });

  // Without this, a busy port fails silently: no URL, no error, and the process keeps running
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`❌ [Hono] Port ${port} is already in use. Stop the other process or choose another port: pnpm demo:serve --port=${port + 1}`);
    } else {
      console.error("❌ [Hono] Server error:", err);
    }
    process.exit(1);
  });
}
