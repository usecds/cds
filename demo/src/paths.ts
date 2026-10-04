// Static output: a route path maps to a file, and links between files are relative,
// so the site works from any folder (and when opened from disk).

// "/" -> "index.html", "/de/" -> "de/index.html", "/about.html" -> "about.html"
export function outputFile(routePath: string): string {
  return (routePath.endsWith("/") ? `${routePath}index.html` : routePath).replace(/^\//, "");
}

// Prefix from a route's output file back to the site root, e.g. "../" for "de/index.html"
export function rootPrefix(routePath: string): string {
  return "../".repeat(outputFile(routePath).split("/").length - 1);
}

// A link from one route to a site path (optionally with #anchor) or an external URL
export function localHref(fromRoutePath: string, href: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return href;
  const [target, anchor] = href.split("#");
  if (target === fromRoutePath && anchor) return `#${anchor}`;
  return rootPrefix(fromRoutePath) + outputFile(target) + (anchor ? `#${anchor}` : "");
}

export const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
