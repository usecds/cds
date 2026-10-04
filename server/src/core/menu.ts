import { CollectionItem } from "../types.js";
import { validateMenuItem } from "../validation.js";
import { BLOCKS_COLLECTION, BlockItem, PageItem, PAGES_COLLECTION, RouteItem, ROUTES_COLLECTION } from "./site.js";

// Optional, typed reserved collection of nestable link items
export const MENU_COLLECTION = "_menu";
export const MAX_MENU_DEPTH = 3; // entry levels below a menu

export interface MenuLink {
  route?: string;
  block?: string;
  url?: string;
}

export interface MenuItem extends CollectionItem {
  children?: string[];
  link?: MenuLink;
}

// Protocol-relative //host links are external too
const EXTERNAL_URL = /^(https?:\/\/|\/\/|mailto:|tel:)/;

/**
 * Checks _menu and the links blocks use. Throws on the first problem: schema errors, unknown
 * children, cycles, menus nested deeper than MAX_MENU_DEPTH, links with neither or both of
 * route/url, unknown routes or blocks, a block that isn't on the route's page, relative URLs,
 * and block links to unknown items.
 */
export function validateMenu(collections: Record<string, CollectionItem[]>): void {
  const items = new Map((collections[MENU_COLLECTION] ?? []).map((i) => [i.id, i as MenuItem]));
  const routes = new Map((collections[ROUTES_COLLECTION] ?? []).map((r) => [r.id, r as RouteItem]));
  const pages = new Map((collections[PAGES_COLLECTION] ?? []).map((p) => [p.id, p as PageItem]));
  const blocks = new Map((collections[BLOCKS_COLLECTION] ?? []).map((b) => [b.id, b as BlockItem]));

  for (const item of items.values()) {
    validateMenuItem(item);
    for (const child of item.children ?? []) {
      if (!items.has(child)) throw new Error(`Invalid _menu item (${item.id}): unknown child "${child}"`);
    }
    const link = item.link;
    if (!link) continue;
    if (!!link.route === !!link.url) {
      throw new Error(`Invalid _menu item (${item.id}): a link needs either a route or a url`);
    }
    if (link.url && !EXTERNAL_URL.test(link.url)) {
      throw new Error(`Invalid _menu item (${item.id}): url must be absolute (https://, //host, mailto:, tel:), got "${link.url}"`);
    }
    if (link.route) {
      const route = routes.get(link.route);
      if (!route) throw new Error(`Invalid _menu item (${item.id}): unknown route "${link.route}"`);
      if (link.block) {
        if (!blocks.has(link.block)) throw new Error(`Invalid _menu item (${item.id}): unknown block "${link.block}"`);
        const onPage = route.page ? pages.get(route.page)?.blocks?.includes(link.block) : false;
        if (!onPage) {
          throw new Error(`Invalid _menu item (${item.id}): block "${link.block}" isn't on the page of route "${link.route}"`);
        }
      }
    } else if (link.block) {
      throw new Error(`Invalid _menu item (${item.id}): a block anchor needs a route`);
    }
  }

  // Cycles and depth, walking down from every item
  const walk = (id: string, path: string[]) => {
    if (path.includes(id)) throw new Error(`Menu cycle: ${[...path, id].join(" -> ")}`);
    if (path.length > MAX_MENU_DEPTH) {
      throw new Error(`Menu ${path[0]} is nested deeper than ${MAX_MENU_DEPTH} levels (${[...path, id].join(" -> ")})`);
    }
    for (const child of items.get(id)?.children ?? []) walk(child, [...path, id]);
  };
  for (const root of menuRoots(collections)) walk(root.id, []);
  // Items in a cycle aren't reachable from any root, so check them as well
  for (const item of items.values()) walk(item.id, []);

  for (const block of blocks.values()) {
    for (const linkId of block.links ?? []) {
      if (!items.has(linkId)) throw new Error(`Invalid _blocks item (${block.id}): unknown _menu link "${linkId}"`);
    }
  }
}

/**
 * Menus: _menu items that no other item lists as a child.
 */
export function menuRoots(collections: Record<string, CollectionItem[]>): MenuItem[] {
  const items = (collections[MENU_COLLECTION] ?? []) as MenuItem[];
  const children = new Set(items.flatMap((i) => i.children ?? []));
  return items.filter((i) => !children.has(i.id));
}

/**
 * Entries (items with a link) that have no label in any locale.
 */
export function menuRecommendations(collections: Record<string, CollectionItem[]>): { collection: string; id: string; issue: string; field: string; message: string }[] {
  return ((collections[MENU_COLLECTION] ?? []) as MenuItem[])
    .filter((i) => i.link && !Object.values(i.translations).some((t) => typeof t?.label === "string" && t.label))
    .map((i) => ({ collection: MENU_COLLECTION, id: i.id, issue: "missing-label", field: "label", message: `Menu entry ${i.id} has no label in any locale, so it's never shown` }));
}
