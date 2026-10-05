import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { CDSClient } from "@usecds/client";
import { createImageRenderer, ImageContract } from "./images.js";
import { renderRoute } from "./site.js";
import { buildLlmsTxt, buildSitemap } from "./outputs.js";

const MIME: Record<string, string> = { avif: "image/avif", webp: "image/webp", png: "image/png", jpg: "image/jpeg", svg: "image/svg+xml" };

/**
 * Server mode (SSR with Hono): every request path is resolved through the client's routes at
 * request time, so a newly synced release is live without a rebuild. Pages only plan their image
 * variants; /media/ renders each variant on its first request into the persistent cache
 * (pre-generate with --mode=images to skip that wait).
 */
export function startServer(options: {
  client: CDSClient;
  renderer: ReturnType<typeof createImageRenderer>;
  contract: ImageContract;
  port: number;
  channel: string;
  syncIntervalMs: number;
}) {
  const { client, renderer, contract, port, channel } = options;
  const { cache, loadSource } = renderer;
  const app = new Hono();

  app.get("/media/:file", async (c) => {
    const name = c.req.param("file");
    // Planned variants are rendered on first request; parallel requests share one render
    if (cache.get(name)) {
      try {
        const variant = await cache.ensure(name, loadSource);
        if (variant.upscaled) console.log(`⚠️  [Imaging] ${name} is upscaled`);
      } catch (err) {
        console.error(`❌ [Imaging] ${name}:`, err);
        return c.notFound();
      }
    }
    const data = await cache.read(name);
    if (!data) return c.notFound();
    return c.body(new Uint8Array(data), 200, {
      "Content-Type": MIME[name.split(".").pop()!] ?? "application/octet-stream",
      // Names carry a content id, so they never change
      "Cache-Control": "public, max-age=31536000, immutable"
    });
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

  // Keep the release current: a new release is served as soon as it's synced. The image cache is
  // keyed by content, so unchanged images aren't rendered again.
  setInterval(async () => {
    const result = await client.sync(channel);
    if (result.updated) console.log(`🔄 [Server] Now serving release ${result.releaseId}`);
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
