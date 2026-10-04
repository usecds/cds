import { CollectionItem, Reference } from "../types.js";
import { validateBlockItem, validatePageItem, validateRouteItem } from "../validation.js";

// Optional, typed reserved collections describing site structure
export const ROUTES_COLLECTION = "_routes";
export const PAGES_COLLECTION = "_pages";
export const BLOCKS_COLLECTION = "_blocks";

export interface RouteItem extends CollectionItem {
  page?: string;
  redirect?: string;
  status?: 301 | 302;
}

export interface PageItem extends CollectionItem {
  blocks?: string[];
}

export interface BlockItem extends CollectionItem {
  type: string;
  items?: Reference[];
  source?: { collection: string };
  links?: string[];
  settings?: Record<string, unknown>;
}

const byId = <T extends CollectionItem>(items: CollectionItem[] | undefined) =>
  new Map((items ?? []).map((i) => [i.id, i as T]));

/**
 * Checks _routes, _pages and _blocks (each only if present). Throws on the first problem:
 * schema errors, a route without page or redirect (or both), unknown pages, routes, blocks,
 * collections or items, redirect cycles, a route without any path, the same path twice in a locale,
 * and blocks with both items and source.
 */
export function validateSite(collections: Record<string, CollectionItem[]>): void {
  const routes = byId<RouteItem>(collections[ROUTES_COLLECTION]);
  const pages = byId<PageItem>(collections[PAGES_COLLECTION]);
  const blocks = byId<BlockItem>(collections[BLOCKS_COLLECTION]);

  const paths = new Map<string, string>(); // "locale path" -> route id
  for (const route of routes.values()) {
    validateRouteItem(route);
    if (!!route.page === !!route.redirect) {
      throw new Error(`Invalid _routes item (${route.id}): needs either a page or a redirect`);
    }
    if (route.page && !pages.has(route.page)) {
      throw new Error(`Invalid _routes item (${route.id}): unknown page "${route.page}"`);
    }
    if (route.redirect && !routes.has(route.redirect)) {
      throw new Error(`Invalid _routes item (${route.id}): redirects to unknown route "${route.redirect}"`);
    }
    const localized = Object.entries(route.translations).filter(([, t]) => typeof t?.path === "string");
    if (localized.length === 0) {
      throw new Error(`Invalid _routes item (${route.id}): has no path in any locale`);
    }
    for (const [locale, t] of localized) {
      const key = `${locale} ${t.path}`;
      const existing = paths.get(key);
      if (existing) throw new Error(`Path ${t.path} (${locale}) is used by routes ${existing} and ${route.id}`);
      paths.set(key, route.id);
    }
  }
  for (const route of routes.values()) {
    const seen = new Set<string>([route.id]);
    let next = route.redirect;
    while (next) {
      if (seen.has(next)) throw new Error(`Redirect cycle: ${[...seen, next].join(" -> ")}`);
      seen.add(next);
      next = routes.get(next)?.redirect;
    }
  }

  for (const page of pages.values()) {
    validatePageItem(page);
    for (const blockId of page.blocks ?? []) {
      if (!blocks.has(blockId)) throw new Error(`Invalid _pages item (${page.id}): unknown block "${blockId}"`);
    }
  }

  for (const block of blocks.values()) {
    validateBlockItem(block);
    if (block.items && block.source) {
      throw new Error(`Invalid _blocks item (${block.id}): use either items or source, not both`);
    }
    if (block.source && !collections[block.source.collection]) {
      throw new Error(`Invalid _blocks item (${block.id}): source collection "${block.source.collection}" doesn't exist`);
    }
    for (const ref of block.items ?? []) {
      if (!collections[ref.collection]?.some((i) => i.id === ref.id)) {
        throw new Error(`Invalid _blocks item (${block.id}): unknown item ${ref.collection}/${ref.id}`);
      }
    }
  }
}

/**
 * Structure that is valid but probably unintended: pages no route shows, blocks no page uses.
 */
export function siteRecommendations(collections: Record<string, CollectionItem[]>): { collection: string; id: string; issue: string; message: string }[] {
  const issues: { collection: string; id: string; issue: string; message: string }[] = [];
  const routedPages = new Set((collections[ROUTES_COLLECTION] ?? []).map((r) => (r as RouteItem).page).filter(Boolean));
  const usedBlocks = new Set((collections[PAGES_COLLECTION] ?? []).flatMap((p) => (p as PageItem).blocks ?? []));

  if (collections[ROUTES_COLLECTION]) {
    for (const page of collections[PAGES_COLLECTION] ?? []) {
      if (!routedPages.has(page.id)) {
        issues.push({ collection: PAGES_COLLECTION, id: page.id, issue: "unrouted-page", message: `Page ${page.id} isn't shown by any route` });
      }
    }
  }
  if (collections[PAGES_COLLECTION]) {
    for (const block of collections[BLOCKS_COLLECTION] ?? []) {
      if (!usedBlocks.has(block.id)) {
        issues.push({ collection: BLOCKS_COLLECTION, id: block.id, issue: "unused-block", message: `Block ${block.id} isn't used by any page` });
      }
    }
  }
  return issues;
}
