import { CDSClient, CollectionItem, MenuEntry, RouteInfo } from "@cds/client";
import { createImageRenderer, ImageContract, PageImages } from "./images.js";
import { renderBlocks, RenderContext } from "./blocks.js";
import { escapeHtml, localHref, rootPrefix } from "./paths.js";

// Absolute base URL of the published demo site (placeholder), for canonical, hreflang and JSON-LD
export const SITE_URL = "https://cds.example.com";

export const LANGUAGE_NAMES: Record<string, string> = { en: "English", de: "Deutsch" };

// How links and assets are written: relative files (static) or root-absolute URLs (server)
export type OutputMode = "static" | "server";

export interface RenderedRoute {
  html: string;
  title: string;
  description: string;
  images: PageImages;
}

/**
 * Renders one route in one locale: the page's blocks inside the layout (head with SEO and JSON-LD,
 * main menu, language switcher from the route's alternates, footer). Shared by both generator modes.
 */
export async function renderRoute(
  client: CDSClient,
  renderer: ReturnType<typeof createImageRenderer>,
  contract: ImageContract,
  route: RouteInfo,
  locale: string,
  mode: OutputMode
): Promise<RenderedRoute | null> {
  const routePath = route.paths[locale];
  const page = route.page && routePath ? await client.getPage(route.page, locale) : null;
  if (!page) return null;

  const href = (target: string) => (mode === "static" ? localHref(routePath, target) : target);
  const images: PageImages = { prefix: mode === "static" ? rootPrefix(routePath) : "/", images: new Map(), reports: [] };
  const releaseId = client.getActiveRelease()!.releaseId;
  const ctx: RenderContext = { client, locale, routePath, releaseId, contract, images, href, picture: renderer.picture };

  const body = await renderBlocks(page, ctx);
  const settings = (await client.getItemByKey("site_settings", "homepage"))?.translations[locale] ?? {};
  const alternates = client.getAlternates(route.id);
  const homePath = client.getRoutes()[0]?.paths[locale] ?? "/";

  // JSON-LD: the page, plus whatever its blocks' items define (e.g. WebSite, Review)
  const jsonLd = await collectJsonLd(client, page.id, locale, routePath, homePath, renderer.mediaUrls);

  const menu = client.getMenu("main", locale) ?? [];
  const menuHtml = menu.map((entry) => menuEntry(entry, href)).join("");
  const switcher = Object.entries(alternates)
    .map(([l, p]) => `<a href="${href(p)}" hreflang="${l}" lang="${l}" class="px-3 py-1.5 rounded-md text-sm font-medium ${l === locale ? "bg-teal-500/10 text-teal-400 border border-teal-500/20" : "text-slate-400 hover:text-slate-200"}">${l.toUpperCase()}</a>`)
    .join("");
  const hreflang = Object.entries(alternates)
    .map(([l, p]) => `<link rel="alternate" hreflang="${l}" href="${SITE_URL}${p}">`)
    .join("\n    ");
  const title = page.title ?? settings.siteTitle ?? "";
  const description = page.description ?? "";

  const html = `<!DOCTYPE html>
<html lang="${locale}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}">
    <link rel="canonical" href="${SITE_URL}${routePath}">
    ${hreflang}
    <link rel="alternate" type="text/markdown" href="${href("/llms.txt")}" title="llms.txt">
    <script type="application/ld+json">${JSON.stringify(jsonLd, null, 2).replace(/</g, "\\u003c")}</script>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
        .code-font { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
        html { scroll-behavior: smooth; scroll-padding-top: 5rem; }
    </style>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen selection:bg-teal-500 selection:text-slate-900">
    <header class="border-b border-slate-800 bg-slate-950/80 backdrop-blur-md sticky top-0 z-50">
        <div class="max-w-6xl mx-auto px-6 py-4 flex flex-wrap gap-4 justify-between items-center">
            <a href="${href(homePath)}" class="flex items-center space-x-3">
                <span class="w-8 h-8 rounded-lg bg-gradient-to-tr from-teal-500 to-blue-600 flex items-center justify-center font-bold text-slate-950">C</span>
                <span class="font-extrabold text-xl tracking-tight bg-gradient-to-r from-teal-400 to-blue-500 bg-clip-text text-transparent">CDS</span>
            </a>
            <nav aria-label="Main" class="flex flex-wrap items-center gap-1">${menuHtml}</nav>
            <nav aria-label="Language" class="flex items-center space-x-2">${switcher}</nav>
        </div>
    </header>
    <main>
${body}
    </main>
    <footer class="py-12 border-t border-slate-900 bg-slate-950">
        <div class="max-w-6xl mx-auto px-6 text-center text-sm text-slate-500">
            <p>${settings.footerText ?? ""}</p>
            <p class="mt-3" data-llms="skip">
                <a href="${href("/llms.txt")}" class="code-font text-xs text-slate-400 hover:text-teal-400 underline underline-offset-4">llms.txt</a>
                <span class="text-slate-600"> · ${locale === "de" ? "Seitentext und Bildbeschreibungen für Sprachmodelle" : "page text and image descriptions for language models"}</span>
            </p>
        </div>
    </footer>
</body>
</html>`;
  return { html, title, description, images };
}

// A menu entry; entries with children open a dropdown on hover and focus
function menuEntry(entry: MenuEntry, href: (target: string) => string): string {
  const linkClass = "block px-3 py-1.5 rounded-md text-sm text-slate-300 hover:text-white hover:bg-slate-800/60";
  const link = entry.href
    ? `<a href="${href(entry.href)}"${entry.external ? ' target="_blank" rel="noopener"' : ""} class="${linkClass}">${entry.label}</a>`
    : `<span class="${linkClass} cursor-default">${entry.label} ▾</span>`;
  if (entry.children.length === 0) return link;
  return `<div class="relative group">${link}
            <div class="absolute left-0 top-full hidden group-hover:block group-focus-within:block min-w-48 rounded-xl border border-slate-800 bg-slate-900 p-1 shadow-xl">${entry.children.map((child) => menuEntry(child, href)).join("")}</div>
        </div>`;
}

/**
 * JSON-LD for a page: the WebPage itself plus definitions for the items its blocks show.
 * URLs come from the generator: page and image URLs are made absolute.
 */
async function collectJsonLd(
  client: CDSClient,
  pageId: string,
  locale: string,
  routePath: string,
  homePath: string,
  mediaUrls: Map<string, string>
): Promise<Record<string, any>[]> {
  const withUrls = (node: any): any => {
    if (Array.isArray(node)) return node.map(withUrls);
    if (typeof node !== "object" || node === null) return node;
    const { _media, ...rest } = node;
    const out: Record<string, any> = Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, withUrls(v)]));
    if (_media && mediaUrls.has(_media)) out.contentUrl = `${SITE_URL}/${mediaUrls.get(_media)}`;
    return out;
  };

  const result: Record<string, any>[] = [];
  const pageItem = await client.getItemById("_pages", pageId);
  const webPage = pageItem ? await client.getJsonLd("_pages", pageItem, locale) : null;
  if (webPage) result.push({ ...withUrls(webPage), "@id": `${SITE_URL}${routePath}`, url: `${SITE_URL}${routePath}` });

  const page = await client.getPage(pageId, locale);
  const seen = new Set<string>();
  for (const block of page?.blocks ?? []) {
    for (const { collection, item } of block.items) {
      const key = `${collection}/${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const data = await client.getJsonLd(collection, item as CollectionItem, locale);
      if (!data) continue;
      // A WebSite describes the whole site, so its URL is the home page in this locale
      result.push(data["@type"] === "WebSite" ? { ...withUrls(data), url: `${SITE_URL}${homePath}` } : withUrls(data));
    }
  }
  return result;
}
