import { CDSClient, RouteInfo } from "@usecds/client";
import { createImageRenderer, ImageContract } from "./images.js";
import { renderLlmsTxt, LlmsPage } from "./llms.js";
import { OutputMode, RenderedRoute, renderRoute, SITE_URL } from "./site.js";
import { escapeHtml } from "./paths.js";

export interface RenderedPage extends LlmsPage {
  route: RouteInfo;
  rendered: RenderedRoute;
}

// Routes in their order, the source locale first within each route
function routeLocales(client: CDSClient): { route: RouteInfo; locale: string; path: string }[] {
  const source = client.getTranslationSummary()?.sourceLocale;
  return client.getRoutes().flatMap((route) =>
    Object.entries(route.paths)
      .sort(([a], [b]) => Number(b === source) - Number(a === source))
      .map(([locale, path]) => ({ route, locale, path })));
}

/**
 * Renders every page route in every locale (redirects are skipped).
 */
export async function renderAllPages(
  client: CDSClient,
  renderer: ReturnType<typeof createImageRenderer>,
  contract: ImageContract,
  mode: OutputMode
): Promise<RenderedPage[]> {
  const pages: RenderedPage[] = [];
  for (const { route, locale, path } of routeLocales(client)) {
    if (route.redirect) continue;
    const rendered = await renderRoute(client, renderer, contract, route, locale, mode);
    if (rendered) pages.push({ route, rendered, locale, path, title: rendered.title, html: rendered.html, images: rendered.images.images });
  }
  return pages;
}

export async function llmsFromPages(client: CDSClient, pages: RenderedPage[]): Promise<string> {
  const source = client.getTranslationSummary()?.sourceLocale ?? "en";
  const settings = (await client.getItemByKey("site_settings", "homepage"))?.translations[source] ?? {};
  return renderLlmsTxt(pages, { title: settings.siteTitle ?? "", summary: settings.heroSubtitle ?? "" }, client.getActiveRelease()!.releaseId);
}

export async function buildLlmsTxt(
  client: CDSClient,
  renderer: ReturnType<typeof createImageRenderer>,
  contract: ImageContract,
  mode: OutputMode
): Promise<string> {
  return llmsFromPages(client, await renderAllPages(client, renderer, contract, mode));
}

/**
 * sitemap.xml with every page URL and its language alternates (hreflang).
 */
export function buildSitemap(client: CDSClient): string {
  const urls = client.getRoutes().filter((r) => !r.redirect).flatMap((route) =>
    Object.values(route.paths).map((path) => `  <url>
    <loc>${escapeHtml(SITE_URL + path)}</loc>
${Object.entries(route.paths).map(([l, p]) => `    <xhtml:link rel="alternate" hreflang="${l}" href="${escapeHtml(SITE_URL + p)}"/>`).join("\n")}
  </url>`));
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls.join("\n")}
</urlset>
`;
}

/**
 * Static stand-in for a redirect: a page that forwards immediately (static hosts can't send 301s;
 * a server would).
 */
export function redirectPage(targetHref: string, canonical: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta http-equiv="refresh" content="0; url=${escapeHtml(targetHref)}">
<link rel="canonical" href="${escapeHtml(canonical)}"><title>Redirect</title></head>
<body><a href="${escapeHtml(targetHref)}">${escapeHtml(targetHref)}</a></body></html>
`;
}
